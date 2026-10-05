import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);

test("Store readiness clears independently of native update readiness", async () => {
  let available = true;
  let ready = false;
  const manager = {
    getIsUpdateReady: () => ready,
    setUpdateReady: (value: boolean) => { ready = value; },
    checkForUpdates: async () => {},
    installUpdatesIfAvailable: async () => {},
  };
  const loaded = {
    factory: Function(
      "state",
      "return function(){ /* sparkleManager setSparkleBridgeHandlers */ return state; }",
    )({ sparkleManager: manager }),
  };
  const moduleLoader = { _load: () => loaded };
  const fakeRequire = Object.assign((name: string) => {
    if (name === "node:fs") return {
      readFileSync: () => JSON.stringify({
        appRoot: "C:\\store-apps\\OpenAI.Codex_1.0.0.0_x64__publisher\\app",
      }),
    };
    if (name === "../updater-discovery.js") return require("../../runtime/platform/updater-discovery.js");
    if (name === "node:path") return path;
    if (name === "node:module") return moduleLoader;
    if (name === "electron") return { app: {}, dialog: {} };
    if (name === "node:child_process") return {
      execFile: (_file: string, args: string[], _options: unknown, callback: Function) => {
        callback(null, args.includes("-File")
          ? JSON.stringify({ available })
          : JSON.stringify({ Version: "1.0.0.0", InstallLocation: "C:\\Store" }));
      },
    };
    throw new Error(`Unexpected require: ${name}`);
  }, { cache: { bootstrap: { filename: "bootstrap-test.js", exports: loaded } } });
  const module = { exports: {} as { start(api: unknown): void; stop(): void } };
  runInNewContext(
    readFileSync(new URL("../../runtime/platform/windows/index.js", import.meta.url), "utf8"),
    {
      module, require: fakeRequire, __dirname: "C:\\runtime",
      process: { platform: "win32", env: { CODEXDC_USER_ROOT: "C:\\CodexDC" } },
      setImmediate: (callback: Function) => callback(),
      setInterval: () => ({ unref() {} }), clearInterval() {},
    },
  );
  module.exports.start({ log: { info() {}, warn() {} } });
  try {
    await manager.checkForUpdates();
    assert.equal(ready, true);
    available = false;
    await manager.checkForUpdates();
    assert.equal(manager.getIsUpdateReady(), false);
    assert.equal(ready, false);

    available = true;
    await manager.checkForUpdates();
    manager.setUpdateReady(true);
    available = false;
    await manager.checkForUpdates();
    assert.equal(ready, true, "native update survives removal of the Store update");

    available = true;
    await manager.checkForUpdates();
    manager.setUpdateReady(false);
    assert.equal(ready, true, "Store update survives clearing the native update");
  } finally {
    module.exports.stop();
  }
  assert.equal(ready, false, "stopping removes the Store readiness overlay");
});

const bridge = require("../../runtime/platform/windows/index.js") as {
  __test: {
    compareVersions(left: string, right: string): number;
    packageDetailsFromAppRoot(appRoot: string): {
      packageName: string;
      packageFamily: string;
      version: string;
    } | null;
    parseCliShim(source: string): { nodePath: string; cliPath: string } | null;
    quoteWindowsCommandLineArgument(value: string): string;
    buildRepairCommandLine(
      shim: { nodePath: string; cliPath: string },
      pid: number,
      storeUpdate?: { packageFamily: string; version: string } | null,
    ): string;
    launchBrokeredWindowsProcess(
      execFile: (...args: unknown[]) => void,
      commandLine: string,
    ): Promise<number>;
    findUpdaterSharedState(exportsValue: unknown): unknown;
    isUpdaterModulePath(path: string): boolean;
    queryInstalledStorePackage(
      execFile: (...args: unknown[]) => void,
      packageName: string,
    ): Promise<{ version: string; installLocation: string } | null>;
    queryAvailableStoreUpdate(
      execFile: (...args: unknown[]) => void,
      scriptPath: string,
      packageFamily: string,
    ): Promise<boolean>;
  };
};

test("Windows update bridge compares dotted Store versions numerically", () => {
  assert.equal(bridge.__test.compareVersions("26.721.3404.0", "26.715.9079.0"), 1);
  assert.equal(bridge.__test.compareVersions("26.715.9079.0", "26.715.9079"), 0);
  assert.equal(bridge.__test.compareVersions("26.715.9", "26.715.10"), -1);
});

test("Windows update bridge derives package identity from a managed mirror", () => {
  assert.deepEqual(
    bridge.__test.packageDetailsFromAppRoot(
      "C:\\Users\\Test\\AppData\\Local\\codex-dc\\store-apps\\OpenAI.Codex_26.715.8383.0_x64__publisher\\app",
    ),
    {
      packageName: "OpenAI.Codex",
      packageFamily: "OpenAI.Codex_publisher",
      version: "26.715.8383.0",
    },
  );
  assert.equal(bridge.__test.packageDetailsFromAppRoot("C:\\Codex\\app"), null);
});

test("Windows update bridge parses the managed CLI shim without cmd quoting", () => {
  assert.deepEqual(
    bridge.__test.parseCliShim(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "D:\\CodexDC\\packages\\installer\\dist\\cli.js" %*\r\n',
    ),
    {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "D:\\CodexDC\\packages\\installer\\dist\\cli.js",
    },
  );
});

test("Windows update bridge builds a quoted repair command line", () => {
  assert.equal(
    bridge.__test.buildRepairCommandLine(
      {
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        cliPath: "D:\\CodexDC\\packages\\installer\\dist\\cli.js",
      },
      1234,
    ),
    '"C:\\Program Files\\nodejs\\node.exe" "D:\\CodexDC\\packages\\installer\\dist\\cli.js" "repair-after-exit" "--pid" "1234"',
  );
  assert.equal(
    bridge.__test.quoteWindowsCommandLineArgument('C:\\path with spaces\\value"quoted"\\'),
    '"C:\\path with spaces\\value\\"quoted\\"\\\\"',
  );
  assert.match(
    bridge.__test.buildRepairCommandLine(
      { nodePath: "node.exe", cliPath: "cli.js" },
      1234,
      { packageFamily: "OpenAI.Codex_publisher", version: "26.715.8383.0" },
    ),
    /"--store-family" "OpenAI\.Codex_publisher" "--store-version" "26\.715\.8383\.0"$/,
  );
});

test("Windows update bridge launches the repair helper through the one-shot WMI broker", async () => {
  let invocation: unknown[] | null = null;
  const execFile = (...args: unknown[]) => {
    invocation = args;
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    callback(null, "4321");
  };

  assert.equal(
    await bridge.__test.launchBrokeredWindowsProcess(
      execFile,
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\CodexDC\\cli.js"',
    ),
    4321,
  );
  assert.equal(invocation?.[0], "powershell.exe");
  const args = invocation?.[1] as string[];
  assert.equal(args.includes("-NonInteractive"), true);
  assert.match(args.at(-1) ?? "", /Invoke-CimMethod -ClassName Win32_Process/);
  assert.match(args.at(-1) ?? "", /C:\\Program Files\\nodejs\\node\.exe/);
});

test("Windows update bridge rejects invalid broker process ids", async () => {
  const execFile = (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    callback(null, "0");
  };
  await assert.rejects(
    bridge.__test.launchBrokeredWindowsProcess(execFile, '"node.exe" "cli.js"'),
    /invalid process id/,
  );
});

test("Windows update bridge locates the updater singleton by semantic shape", () => {
  const sharedState = {
    sparkleManager: {
      getIsUpdateReady() { return false; },
      installUpdatesIfAvailable() {},
    },
  };
  const exportsValue = {
    unrelated: () => null,
    currentMinifiedExport: Function(
      "state",
      "return function(){ /* sparkleManager setSparkleBridgeHandlers */ return state; }",
    )(sharedState),
  };
  assert.equal(bridge.__test.findUpdaterSharedState(exportsValue), sharedState);
  assert.equal(bridge.__test.isUpdaterModulePath(".vite\\build\\bootstrap-DwqRMhlU.js"), true);
  assert.equal(bridge.__test.isUpdaterModulePath("window-all-closed-123.js"), true);
  assert.equal(bridge.__test.isUpdaterModulePath("renderer-bootstrap-123.js"), false);
});

test("Windows update bridge parses Get-AppxPackage output", async () => {
  const execFile = (...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    callback(null, '{"Version":"26.721.3404.0","InstallLocation":"C:\\\\Program Files\\\\WindowsApps\\\\OpenAI.Codex"}');
  };
  assert.deepEqual(
    await bridge.__test.queryInstalledStorePackage(execFile, "OpenAI.Codex"),
    {
      version: "26.721.3404.0",
      installLocation: "C:\\Program Files\\WindowsApps\\OpenAI.Codex",
    },
  );
});

test("Windows update bridge checks the Store for its exact package family", async () => {
  let args: string[] = [];
  const execFile = (...invocation: unknown[]) => {
    args = invocation[1] as string[];
    const callback = invocation.at(-1) as (error: Error | null, stdout: string) => void;
    callback(null, '{"available":true}');
  };
  assert.equal(
    await bridge.__test.queryAvailableStoreUpdate(
      execFile,
      "C:\\CodexDC\\store-update.ps1",
      "OpenAI.Codex_publisher",
    ),
    true,
  );
  assert.deepEqual(args.slice(-3), [
    "C:\\CodexDC\\store-update.ps1",
    "check",
    "OpenAI.Codex_publisher",
  ]);
});
