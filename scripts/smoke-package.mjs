import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractPackage } from "../packages/installer/dist/releases.js";

const stage = mkdtempSync(join(tmpdir(), "CodexDC package with spaces "));
const profile = mkdtempSync(join(tmpdir(), "CodexDC profile with spaces "));
try {
  const archive = resolve("dist", `CodexDC-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
  await extractPackage(archive, stage);
  const node = join(stage, "node", process.platform === "win32" ? "node.exe" : "node");
  const cli = join(stage, "packages", "installer", "dist", "cli.js");
  const options = { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, CODEXDC_HOME: profile } };
  mkdirSync(options.env.CODEXDC_HOME, { recursive: true });
  execFileSync(node, [cli, "--help"], options);
  const installModule = join(stage, "packages", "installer", "dist", "commands", "install.js");
  const runtime = join(options.env.CODEXDC_HOME, "runtime");
  execFileSync(node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const require = createRequire(import.meta.url);
    const { stageAssets } = await import(pathToFileURL(process.argv[1]));
    stageAssets(process.argv[2]);
    assert.equal(existsSync(join(process.argv[2], "desktop-bootstrap.js")), true);
    if (process.platform === "win32") {
      const restart = require(join(process.argv[2], "native", "codexdc_windows_restart.node"));
      restart.unregisterRestart();
      assert.equal(restart.getRestartRegistration(), null);
    }
    const { findUpdaterSharedState } = require(join(process.argv[2], "platform", "updater-discovery.js"));
    const { attachManager } = require(join(process.argv[2], "platform", "macos", "index.js"));
    const manager = { getIsUpdateReady: () => false, installUpdatesIfAvailable() {} };
    const state = { appUpdates: manager, setSparkleBridgeHandlers() {} };
    const factory = () => { const { appUpdates, setSparkleBridgeHandlers } = state; return state; };
    assert.equal(findUpdaterSharedState({ I: factory }), state);
    attachManager(state.appUpdates, {});
    assert.equal(manager.hasUpdater(), true);
    assert.equal(manager.getUnavailableReason(), null);
  `, installModule, runtime], options);
  if (process.platform === "win32") {
    execFileSync(node, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      const { guardWindowsLaunch } = await import(pathToFileURL(process.argv[1]));
      const root = process.argv[2];
      mkdirSync(join(root, "app", "resources"), { recursive: true });
      writeFileSync(join(root, "app", "ChatGPT.exe"), "fixture");
      let rows = [{
        pid: 123, parentPid: 1, executable: join(root, "app", "ChatGPT.exe"),
        commandLine: "", startedAt: new Date().toISOString(), name: "ChatGPT.exe",
      }];
      let kills = 0;
      const deps = {
        inspect: () => rows, confirm: () => false, identifyDesktop: () => true,
        readLoaded: () => null,
        kill: () => { kills++; rows = []; },
      };
      const state = { appRoot: join(root, "app") };
      assert.equal(guardWindowsLaunch(state, { provider: "bundled" }, root, deps), false);
      assert.equal(kills, 0);
      deps.confirm = () => true;
      assert.equal(guardWindowsLaunch(state, { provider: "bundled" }, root, deps), true);
      assert.equal(kills, 1);
    `, join(stage, "packages", "installer", "dist", "windows-launch-guard.js"), profile], options);
  }
  // Exercise the updater from the extracted release, without requesting an update.
  const storeUpdateModule = join(stage, "packages", "installer", "dist", "windows-store-update.js");
  execFileSync(node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { readFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    childProcess.execFileSync = (file, args) => {
      assert.equal(file, "powershell.exe");
      const scriptIndex = args.indexOf("-File") + 1;
      assert.ok(scriptIndex > 0);
      assert.match(readFileSync(args[scriptIndex], "utf8"), /UpdateAppByPackageFamilyNameAsync/);
      assert.deepEqual(args.slice(scriptIndex + 1), ["start", "OpenAI.Codex_2p2nqsd0c76g0"]);
      return '{"queued":true}';
    };
    syncBuiltinESMExports();
    const updater = await import(pathToFileURL(process.argv[1]).href);
    assert.equal(updater.startStoreUpdate("OpenAI.Codex_2p2nqsd0c76g0"), true);
  `, storeUpdateModule], options);
  // Startup maintenance must resolve its helper from an extracted release too.
  execFileSync(node, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { readFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    childProcess.execFileSync = (file, args) => {
      assert.equal(file, "powershell.exe");
      const scriptIndex = args.indexOf("-File") + 1;
      assert.match(readFileSync(args[scriptIndex], "utf8"), /windows.startupTask/);
      assert.deepEqual(args.slice(scriptIndex + 1), [
        "-PackageFamily", "OpenAI.Codex_2p2nqsd0c76g0", "-Mode", "disable",
      ]);
      return '[{"taskId":"App","state":1,"changed":true}]';
    };
    syncBuiltinESMExports();
    const startup = await import(pathToFileURL(process.argv[1]).href);
    assert.deepEqual(startup.officialWindowsStartupTasks({
      platform: "win32",
      appRoot: join(process.cwd(), "codex-dc", "store-apps", "OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0", "app"),
    }, true), [{ taskId: "App", state: 1, changed: true }]);
  `, join(stage, "packages", "installer", "dist", "windows-startup.js")], options);
  assert.deepEqual(JSON.parse(execFileSync(node, [cli, "backend", "status"], options)), { provider: "fork" });
  const tweak = join(stage, "development tweak");
  mkdirSync(tweak);
  writeFileSync(join(tweak, "manifest.json"), JSON.stringify({
    id: "test.development", name: "Development", version: "1.0.0", scope: "renderer", main: "index.js",
  }));
  writeFileSync(join(tweak, "index.js"), "exports.start = () => {};");
  execFileSync(node, [cli, "dev", tweak, "--no-watch"], { ...options, timeout: 10_000 });
  assert.equal(realpathSync(join(options.env.CODEXDC_HOME, "tweaks", "test.development")), realpathSync(tweak));
  // Setup shortcuts retain their original command after updates. Exercise that
  // old entry point across two activations using real child processes.
  for (const version of ["next", "newest"]) {
    const active = join(stage, version);
    mkdirSync(join(active, "node"), { recursive: true });
    mkdirSync(join(active, "packages", "installer", "dist"), { recursive: true });
    linkSync(node, join(active, "node", process.platform === "win32" ? "node.exe" : "node"));
    writeFileSync(join(active, "packages", "installer", "dist", "cli.js"),
      `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), cwd: process.cwd(), desktopArgs: process.env.CODEXDC_DESKTOP_ARGS }));`);
    writeFileSync(join(options.env.CODEXDC_HOME, "maintenance-selection.json"), JSON.stringify({ active, previous: stage }));
    const result = JSON.parse(execFileSync(node, [cli, "launch"], {
      ...options,
    }));
    assert.deepEqual(result, { version, args: ["launch"], cwd: realpathSync(active) });
    const desktopArgs = ["C:\\Project with spaces", "--example"];
    const shortcutResult = JSON.parse(execFileSync(node, [
      join(stage, "packages", "installer", "dist", "desktop-launch.js"), ...desktopArgs,
    ], options));
    assert.deepEqual(shortcutResult, {
      version, args: ["launch"], cwd: realpathSync(active), desktopArgs: JSON.stringify(desktopArgs),
    });
  }
  const candidate = JSON.parse(execFileSync(node, [cli, "backend", "status"], {
    ...options, env: { ...options.env, CODEXDC_ACTIVATING: "1" },
  }));
  assert.deepEqual(candidate, { provider: "fork" });
  console.log("Extracted package passed: bundled runtime, current updater bridge, repeated launch forwarding, and candidate activation bypass.");
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
