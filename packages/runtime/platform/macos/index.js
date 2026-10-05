"use strict";
const { findUpdaterSharedState, isUpdaterModulePath } = require("../updater-discovery.js");

function attachManager(manager, services) {
  let ready = false;
  let installing = false;
  let checkInFlight;
  const refresh = () => checkInFlight ??= services.check().then(result => {
    ready = result.ready || !!result.online;
    manager.setUpdateReady(ready);
    return result;
  }).finally(() => { checkInFlight = null; });
  manager.getIsUpdateReady = () => ready;
  manager.checkForUpdates = async () => {
    try {
      const result = await refresh();
      await services.message(result.online ? `ChatGPT ${result.online.version} is available. Use the update action to download it and restart CodexDC.` : result.ready ? "A desktop update is ready. Restart CodexDC to apply it." :
        "No newer compatible release was found in the official update feed.");
    } catch (error) { await services.error(error); }
  };
  manager.checkForUpdatesInBackground = refresh;
  manager.checkForUpdateInformation = async () => {
    if (installing) return { status: "busy" };
    const result = await refresh();
    return result.ready || result.online ? { status: "restart_required" } : { status: "up_to_date" };
  };
  manager.installUpdatesIfAvailable = async () => {
    if (installing) return false;
    installing = true;
    try {
      const update = await refresh();
      if (!update.ready && !update.online) { installing = false; return false; }
      manager.setUpdateLifecycleState("downloading");
      await services.prepare(percent => manager.setDownloadProgressPercent(percent));
      manager.setDownloadProgressPercent(null);
      manager.setUpdateLifecycleState("installing");
      services.quit();
      return true;
    } catch (error) {
      installing = false;
      manager.setDownloadProgressPercent(null);
      manager.setUpdateLifecycleState(ready ? "ready" : "idle");
      await services.error(error);
      return false;
    }
  };
  // The managed copy must never initialize the publisher's in-place updater.
  manager.initializeMacSparkle = async () => {};
  manager.hasUpdater = () => true;
  manager.getUnavailableReason = () => null;
  return () => installing ? Promise.resolve() : refresh();
}

function prepareHelper(spawn, node, cli, env, pid, progress = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, "mac-update", "--pid", String(pid)], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env,
    });
    const timer = setTimeout(() => { child.kill(); finish(new Error("Update helper did not become ready.")); }, 25 * 60 * 1000);
    const onExit = code => finish(new Error(`Update helper exited before readiness (${code}).`));
    const onError = error => finish(error);
    const finish = error => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.removeListener("message", onMessage);
      if (error) reject(error);
      else { child.unref(); resolve(); }
    };
    const onMessage = message => {
      if (message?.type === "ready") finish();
      else if (message?.type === "progress") progress(message.percent);
      else if (message?.type === "failed") finish(new Error(message.message));
    };
    child.once("exit", onExit);
    child.once("error", onError);
    child.on("message", onMessage);
  });
}

function start(api) {
  const fs = require("node:fs");
  const path = require("node:path");
  const Module = require("node:module");
  const { execFile, spawn } = require("node:child_process");
  const { app, dialog } = require("electron");
  const root = process.env.CODEXDC_USER_ROOT;
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  const cli = path.join(state.sourceRoot, "packages/installer/dist/cli.js");
  const env = { ...process.env, CODEXDC_HOME: root };
  const showError = error => dialog.showMessageBox({ type: "error", message: "CodexDC update failed", detail: String(error), buttons: ["OK"] });
  let startupConfirmed = false;
  let confirmingStartup = false;
  let desktopLoaded = false;
  const confirmStartup = () => {
    if (!desktopLoaded || startupConfirmed || confirmingStartup) return;
    confirmingStartup = true;
    execFile(state.nodePath, [cli, "mac-confirm-startup", state.installedAt], { env, timeout: 60000 }, (error, stdout, stderr) => {
      confirmingStartup = false;
      if (error) api.log.warn("Desktop startup confirmation failed", stderr || error.message);
      else {
        startupConfirmed = true;
        api.log.info("Desktop startup confirmed; retention applied", stdout.trim());
      }
    });
  };
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "window") return;
    contents.once("did-finish-load", () => {
      if (!contents.getURL().startsWith("app://")) return;
      desktopLoaded = true;
      confirmStartup();
    });
  });
  let attached = false;
  function inspect(loaded) {
    if (attached) return;
    const shared = findUpdaterSharedState(loaded);
    if (!shared) return;
    attached = true;
    const refresh = attachManager(shared.sparkleManager, {
      check: () => new Promise((resolve, reject) => execFile(state.nodePath, [cli, "mac-update"],
        { env, timeout: 15000 }, (error, stdout, stderr) => {
          if (error) { reject(new Error(stderr || error.message)); return; }
          try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        })),
      prepare: progress => prepareHelper(spawn, state.nodePath, cli, env, process.pid, progress),
      quit: () => app.quit(),
      message: message => dialog.showMessageBox({ type: "info", message, buttons: ["OK"] }),
      error: showError,
    });
    const poll = () => {
      confirmStartup();
      return refresh().catch(error => api.log.warn("macOS update check failed", error));
    };
    app.whenReady().then(() => {
      poll();
      const resultPath = path.join(root, "mac-update-result.json");
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        fs.unlinkSync(resultPath);
        if (result.error) void showError(result.error);
      }
    });
    const timer = setInterval(poll, 5 * 60 * 1000);
    timer.unref();
    app.once("will-quit", () => clearInterval(timer));
    api.log.info("macOS managed update bridge attached");
  }
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    const loaded = original.apply(this, [request, parent, isMain]);
    if (isUpdaterModulePath(request)) inspect(loaded);
    return loaded;
  };
  for (const cached of Object.values(require.cache)) {
    if (isUpdaterModulePath(cached?.filename)) inspect(cached.exports);
  }
}
module.exports = { start, attachManager, prepareHelper };
