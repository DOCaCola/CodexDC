"use strict";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const PATCH_MARKER = "__codexppWindowsStoreUpdateBridge";

let moduleLoadOwner = null;
let originalModuleLoad = null;
let moduleLoadWrapper = null;
let pollTimer = null;
let patchedManager = null;
let restoreManager = null;

function compareVersions(left, right) {
  const a = String(left ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function packageDetailsFromAppRoot(appRoot) {
  const normalized = String(appRoot ?? "").replace(/\//g, "\\");
  const match = normalized.match(
    /\\([^\\]+)_([0-9]+(?:\.[0-9]+)+)_(?:x64|x86|arm64)__([^\\]+)\\app\\?$/i,
  );
  if (!match) return null;
  return {
    packageName: match[1],
    packageFamily: `${match[1]}_${match[3]}`,
    version: match[2],
  };
}

function parseCliShim(source) {
  const match = String(source ?? "").match(/^\s*"([^"]+)"\s+"([^"]+)"\s+%\*/im);
  if (!match) return null;
  return { nodePath: match[1], cliPath: match[2] };
}

function quoteWindowsCommandLineArgument(value) {
  let quoted = '"';
  let backslashes = 0;
  for (const char of String(value)) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function buildRepairCommandLine(shim, pid, storeUpdate = null) {
  const args = [shim.nodePath, shim.cliPath, "repair-after-exit", "--pid", String(pid)];
  if (storeUpdate) {
    args.push("--store-family", storeUpdate.packageFamily, "--store-version", storeUpdate.version);
  }
  return args
    .map(quoteWindowsCommandLineArgument)
    .join(" ");
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function launchBrokeredWindowsProcess(execFile, commandLine) {
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quotePowerShellLiteral(commandLine)} };`,
    "if ([int]$result.ReturnValue -ne 0) { throw \"Win32_Process.Create failed with code $($result.ReturnValue)\" };",
    "[Console]::Out.Write([string]$result.ProcessId)",
  ].join(" ");
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
  });
  const pid = Number.parseInt(String(stdout ?? "").trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Windows process broker returned an invalid process id: ${String(stdout ?? "")}`);
  }
  return pid;
}

function isUpdaterManager(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.sparkleManager &&
      typeof value.sparkleManager.getIsUpdateReady === "function" &&
      typeof value.sparkleManager.installUpdatesIfAvailable === "function",
  );
}

function findUpdaterSharedState(exportsValue) {
  if (!exportsValue || (typeof exportsValue !== "object" && typeof exportsValue !== "function")) {
    return null;
  }

  const candidates = [exportsValue];
  if (exportsValue.default && exportsValue.default !== exportsValue) {
    candidates.push(exportsValue.default);
  }

  for (const candidate of candidates) {
    for (const key of Object.getOwnPropertyNames(candidate)) {
      let factory;
      try {
        factory = candidate[key];
      } catch {
        continue;
      }
      if (typeof factory !== "function") continue;
      const source = Function.prototype.toString.call(factory);
      if (!source.includes("sparkleManager") || !source.includes("setSparkleBridgeHandlers")) {
        continue;
      }
      try {
        const sharedState = factory();
        if (isUpdaterManager(sharedState)) return sharedState;
      } catch {
        // Ignore unrelated exports that happen to contain the semantic anchors.
      }
    }
  }
  return null;
}

function isUpdaterModulePath(value) {
  return /(?:^|[/\\])(?:window-all-closed|bootstrap)-[^/\\]+\.js$/i.test(String(value));
}

function readInstallerState(fs, path, userRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userRoot, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

async function queryInstalledStorePackage(execFile, packageName) {
  if (!/^[A-Za-z0-9_.-]+$/.test(packageName)) {
    throw new Error(`Invalid Windows package name: ${packageName}`);
  }
  const command = [
    `$pkg = Get-AppxPackage -Name '${packageName}'`,
    "| Sort-Object Version -Descending",
    "| Select-Object -First 1 Version,InstallLocation;",
    "if ($pkg) { $pkg | ConvertTo-Json -Compress }",
  ].join(" ");
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
  });
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  const parsed = JSON.parse(text);
  const version = String(parsed.Version ?? "").trim();
  const installLocation = String(parsed.InstallLocation ?? "").trim();
  return version && installLocation ? { version, installLocation } : null;
}

async function queryAvailableStoreUpdate(execFile, scriptPath, packageFamily) {
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "check",
        packageFamily,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 45_000 },
      (error, output) => (error ? reject(error) : resolve(output)),
    );
  });
  return JSON.parse(String(stdout ?? "").trim()).available === true;
}

function start(api) {
  if (process.platform !== "win32") return;

  const fs = require("node:fs");
  const path = require("node:path");
  const childProcess = require("node:child_process");
  const Module = require("node:module");
  const { app, dialog } = require("electron");
  const userRoot = process.env.CODEXDC_USER_ROOT;
  if (!userRoot || typeof Module._load !== "function") {
    api.log.warn("Windows Store update bridge could not initialize");
    return;
  }

  const installerState = readInstallerState(fs, path, userRoot);
  const packageDetails = packageDetailsFromAppRoot(installerState?.appRoot);
  if (!packageDetails) {
    api.log.info("Windows Store update bridge skipped: managed Store package was not identified");
    return;
  }
  const storeUpdateScript = path.join(__dirname, "store-update.ps1");

  let customUpdate = null;
  let refreshInFlight = null;
  let repairStarted = false;

  const refreshStoreUpdate = async () => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = queryInstalledStorePackage(childProcess.execFile, packageDetails.packageName)
      .then(async (installed) => {
        const newer = installed && compareVersions(installed.version, packageDetails.version) > 0;
        customUpdate = newer
          ? { kind: "installed", ...installed }
          : (await queryAvailableStoreUpdate(
              childProcess.execFile,
              storeUpdateScript,
              packageDetails.packageFamily,
            ))
            ? { kind: "available" }
            : null;
        if (customUpdate && patchedManager) {
          patchedManager.setUpdateReady(true);
          const detail = newer
            ? `${packageDetails.version} -> ${installed.version} is installed and ready for CodexDC repair`
            : `is available for ${packageDetails.packageFamily}`;
          api.log.info(`Codex Store update ${detail}`);
        }
        return customUpdate;
      })
      .catch((error) => {
        api.log.warn("Windows Store update check failed", error);
        return customUpdate;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  };

  const launchRepairAfterExit = async (manager, update) => {
    if (repairStarted) return true;
    const shimPath = path.join(userRoot, "bin", "codexdc.cmd");
    let shim;
    try {
      shim = parseCliShim(fs.readFileSync(shimPath, "utf8"));
    } catch {
      shim = null;
    }
    if (!shim || !fs.existsSync(shim.nodePath) || !fs.existsSync(shim.cliPath)) {
      await dialog.showMessageBox({
        type: "error",
        buttons: ["OK"],
        message: "CodexDC could not start the update repair.",
        detail: "Run codexdc repair --force from a terminal, then reopen CodexDC.",
        noLink: true,
      });
      return false;
    }

    repairStarted = true;
    let helperPid;
    try {
      helperPid = await launchBrokeredWindowsProcess(
        childProcess.execFile,
        buildRepairCommandLine(
          shim,
          process.pid,
          update.kind === "available" ? packageDetails : null,
        ),
      );
    } catch (error) {
      repairStarted = false;
      api.log.error("CodexDC Store update repair helper failed to launch", error);
      await dialog.showMessageBox({
        type: "error",
        buttons: ["OK"],
        message: "CodexDC could not start the update repair.",
        detail: error instanceof Error ? error.message : String(error),
        noLink: true,
      });
      return false;
    }

    manager.setUpdateLifecycleState?.("installing");
    api.log.info(`Started brokered CodexDC Store update repair helper pid=${helperPid}`);

    const requestQuit = manager.options?.onInstallUpdatesRequested;
    if (typeof requestQuit === "function") {
      requestQuit({ quitImmediately: true });
    } else {
      app.quit();
    }
    return true;
  };

  const patchSharedState = (sharedState) => {
    const manager = sharedState?.sparkleManager;
    if (!manager || manager[PATCH_MARKER]) return;

    const original = {
      checkForUpdates: manager.checkForUpdates.bind(manager),
      getIsUpdateReady: manager.getIsUpdateReady.bind(manager),
      installUpdatesIfAvailable: manager.installUpdatesIfAvailable.bind(manager),
      setUpdateReady: manager.setUpdateReady.bind(manager),
    };
    Object.defineProperty(manager, PATCH_MARKER, { value: true, configurable: true });

    manager.getIsUpdateReady = () => Boolean(customUpdate) || original.getIsUpdateReady();
    manager.setUpdateReady = (ready) => original.setUpdateReady(customUpdate ? true : ready);
    manager.checkForUpdates = async (...args) => {
      await refreshStoreUpdate();
      if (customUpdate) return;
      return original.checkForUpdates(...args);
    };
    manager.installUpdatesIfAvailable = async (...args) => {
      await refreshStoreUpdate();
      if (customUpdate) return launchRepairAfterExit(manager, customUpdate);
      return original.installUpdatesIfAvailable(...args);
    };

    patchedManager = manager;
    restoreManager = () => {
      manager.checkForUpdates = original.checkForUpdates;
      manager.getIsUpdateReady = original.getIsUpdateReady;
      manager.installUpdatesIfAvailable = original.installUpdatesIfAvailable;
      manager.setUpdateReady = original.setUpdateReady;
      try {
        delete manager[PATCH_MARKER];
      } catch {}
    };
    refreshStoreUpdate();
    pollTimer = setInterval(refreshStoreUpdate, POLL_INTERVAL_MS);
    pollTimer.unref?.();
    api.log.info("Windows Store update bridge attached to the native Codex updater");
  };

  const inspectLoadedModule = (loaded) => {
    const sharedState = findUpdaterSharedState(loaded);
    if (sharedState) patchSharedState(sharedState);
  };

  const inspectLoadedModuleLater = (loaded) => {
    setImmediate(() => inspectLoadedModule(loaded));
  };

  moduleLoadOwner = Module;
  originalModuleLoad = Module._load;
  moduleLoadWrapper = function codexPlusPlusWindowsUpdateModuleLoad(request, parent, isMain) {
    const loaded = originalModuleLoad.apply(this, [request, parent, isMain]);
    if (isUpdaterModulePath(request)) {
      inspectLoadedModuleLater(loaded);
    }
    return loaded;
  };
  Module._load = moduleLoadWrapper;

  for (const cached of Object.values(require.cache)) {
    if (isUpdaterModulePath(cached?.filename)) {
      inspectLoadedModuleLater(cached.exports);
    }
  }
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  restoreManager?.();
  restoreManager = null;
  patchedManager = null;
  if (moduleLoadOwner && originalModuleLoad && moduleLoadOwner._load === moduleLoadWrapper) {
    moduleLoadOwner._load = originalModuleLoad;
  }
  moduleLoadOwner = null;
  originalModuleLoad = null;
  moduleLoadWrapper = null;
}

module.exports = {
  start,
  stop,
  __test: {
    compareVersions,
    packageDetailsFromAppRoot,
    parseCliShim,
    quoteWindowsCommandLineArgument,
    buildRepairCommandLine,
    launchBrokeredWindowsProcess,
    findUpdaterSharedState,
    isUpdaterModulePath,
    queryInstalledStorePackage,
    queryAvailableStoreUpdate,
  },
};
