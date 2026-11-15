// Use an isolated Owl host, fixture ASAR and profile; never launch a user task.
// Usage: node scripts/smoke-windows-startup.mjs <existing-managed-app> [package-root]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as asar from "@electron/asar";
import { desktopFingerprint } from "../packages/sdk/dist/desktop-fingerprint.js";

if (process.platform !== "win32") throw new Error("This smoke test requires Windows.");
const source = resolve(process.argv[2]);
const packageRoot = resolve(process.argv[3] ?? ".");
const moduleAt = name => import(pathToFileURL(join(packageRoot, "packages/installer/dist", name)));
const { setWindowsEmbeddedAsarIntegrity } = await moduleAt("integrity.js");
const { readHeaderHash } = await moduleAt("asar.js");
const { inspectWindowsLaunch, findLaunchConflicts, windowsGuardProcessOptions } = await moduleAt("windows-launch-guard.js");
const { launchWindowsDesktop } = await moduleAt("windows-desktop-launch.js");
const assets = join(packageRoot, "packages/installer/assets");
// Same drive as the managed copy permits read-only hardlinks for large DLLs.
const root = mkdtempSync(join(process.env.LOCALAPPDATA, "Temp", "CodexDC startup test "));
let child;
let childClosed;
try {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "resources") continue;
    const destination = join(root, entry.name);
    if (entry.isDirectory()) symlinkSync(join(source, entry.name), destination, "junction");
    else if (entry.name === "ChatGPT.exe") copyFileSync(join(source, entry.name), destination);
    else linkSync(join(source, entry.name), destination);
  }
  const resources = join(root, "resources"), fixture = join(root, "fixture"), home = join(root, "home");
  mkdirSync(resources); mkdirSync(fixture); mkdirSync(home);
  writeFileSync(join(resources, "owl-app.ini"), "[Owl]\nUserDataDirectoryName=CodexDCStartupTest\nAppVersion=1.0.0\n");
  cpSync(join(assets, "runtime"), join(home, "runtime"), { recursive: true });
  // The original app is a fixture: it never starts Codex or connects to accounts.
  writeFileSync(join(home, "runtime/main.js"), "module.exports = {};");
  writeFileSync(join(home, "backend.json"), JSON.stringify({
    provider: "development", development: { executable: process.execPath },
  }));
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    name: "openai-codex-electron", version: "1.0.0", main: "codexdc-loader.cjs",
    __codexpp: { originalMain: "main.cjs", userRoot: home },
  }));
  copyFileSync(join(assets, "loader.cjs"), join(fixture, "codexdc-loader.cjs"));
  writeFileSync(join(fixture, "main.cjs"), `
    const fs=require("node:fs"),path=require("node:path");
    const {app,BrowserWindow}=require("electron");
    const server=require("node:child_process").spawn(process.env.CODEX_CLI_PATH,
      ["-e","setInterval(()=>{},1000)","--","app-server"],{stdio:"ignore"});
    const restart=require(path.join(process.env.CODEXDC_RUNTIME,"native","codexdc_windows_restart.node"));
    app.whenReady().then(()=>{
      const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
      window.loadURL("about:blank");
      setTimeout(()=>{
      fs.writeFileSync(process.env.CODEXDC_TEST_RESULT,JSON.stringify({
        pid:process.pid,backend:process.env.CODEX_CLI_PATH,
        restartRegistration:restart.getRestartRegistration()
      }));
    },1600)});
    app.on("quit",()=>{try{server.kill()}catch{}});
    setTimeout(()=>app.exit(0),15000);
  `);
  await asar.createPackage(fixture, join(resources, "app.asar"));
  setWindowsEmbeddedAsarIntegrity(join(root, "ChatGPT.exe"), readHeaderHash(join(resources, "app.asar")).headerHash);
  const resultFile = join(root, "result.json");
  const env = { ...process.env, CODEX_ELECTRON_USER_DATA_PATH: join(root, "profile"),
    CODEX_CLI_PATH: "C:\\obsolete\\codex.exe", CODEXDC_TEST_RESULT: resultFile };
  const args = ["--no-first-run", `--user-data-dir=${join(root, "profile")}`, "--restore-last-session", "--restart"];
  child = launchWindowsDesktop(join(root, "ChatGPT.exe"), args, env);
  childClosed = new Promise(done => child.once("close", done));
  const deadline = Date.now() + 15_000;
  while (!existsSync(resultFile)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture did not start (exit ${child.exitCode})`);
    await new Promise(done => setTimeout(done, 100));
  }
  const result = JSON.parse(readFileSync(resultFile));
  assert.equal(result.pid, child.pid);
  assert.equal(result.backend, process.execPath);
  assert.equal(result.restartRegistration, null);
  const snapshot = inspectWindowsLaunch();
  const records = snapshot.processes.filter(row => row.pid === child.pid || row.parentPid === child.pid);
  const server = records.find(row => row.parentPid === child.pid && /(?:^|\s)app-server(?:\s|$)/.test(row.commandLine));
  assert.ok(server, "fixture backend must be running");
  assert.equal(server.elevated, snapshot.launcherElevated, "the backend must inherit the launcher's elevation");
  const conflicts = findLaunchConflicts(records, {
    executable: join(root, "ChatGPT.exe"), backend: process.execPath,
    launcherElevated: snapshot.launcherElevated,
    runtimeHash: desktopFingerprint(join(home, "runtime"), readFileSync(join(fixture, "codexdc-loader.cjs"))),
  }, pid => JSON.parse(readFileSync(join(home, "desktop-instances", `${pid}.json`))));
  assert.deepEqual(conflicts, []);
  // Reproduce a real browser tree, whose sandbox children exit with the root.
  // Disposable Node-only trees do not cover the .NET Kill/exit race.
  const target = records.find(row => row.pid === child.pid);
  execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(assets, "windows-launch-guard.ps1"), "kill",
  ], windowsGuardProcessOptions("kill", { CODEXDC_LAUNCH_TARGETS: JSON.stringify([target]) }));
  await childClosed;
  rmSync(resultFile);
  child = launchWindowsDesktop(join(root, "ChatGPT.exe"), args, env);
  childClosed = new Promise(done => child.once("close", done));
  const restartDeadline = Date.now() + 15_000;
  while (!existsSync(resultFile)) {
    if (child.exitCode !== null || Date.now() > restartDeadline) throw new Error(`Fixture did not restart (exit ${child.exitCode})`);
    await new Promise(done => setTimeout(done, 100));
  }
  const restarted = JSON.parse(readFileSync(resultFile));
  assert.equal(restarted.pid, child.pid);
  assert.notEqual(restarted.pid, result.pid);
  assert.equal(restarted.backend, process.execPath);
  assert.equal(restarted.restartRegistration, null);
  const restartSnapshot = inspectWindowsLaunch();
  const restartedBackend = restartSnapshot.processes.find(row => row.parentPid === child.pid &&
    /(?:^|\s)app-server(?:\s|$)/.test(row.commandLine));
  assert.ok(restartedBackend);
  assert.equal(restartedBackend.elevated, restartSnapshot.launcherElevated);
  const exitCode = await childClosed;
  assert.equal(exitCode, 0);
  assert.equal(existsSync(join(home, "desktop-instances", `${restarted.pid}.json`)), false);
  console.log(`Isolated Owl startup, sandbox-tree kill and relaunch passed: saved backend, restart opt-out, token inheritance (${packageRoot}).`);
} finally {
  if (child && child.exitCode === null) {
    child.kill();
  }
  if (childClosed) await childClosed;
  // Let libuv release the detached process handle after its close callback.
  await new Promise(done => setImmediate(done));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) unlinkSync(join(root, entry.name));
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
