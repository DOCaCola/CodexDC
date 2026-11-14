// Use an isolated Owl host, fixture ASAR and profile; never launch a user task.
// Usage: node scripts/smoke-windows-startup.mjs <existing-managed-app> [package-root]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
const { inspectWindowsProcesses, findLaunchConflicts } = await moduleAt("windows-launch-guard.js");
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
    const {app}=require("electron");
    const server=require("node:child_process").spawn(process.env.CODEX_CLI_PATH,
      ["-e","setInterval(()=>{},1000)","--","app-server"],{stdio:"ignore"});
    const restart=require(path.join(process.env.CODEXDC_RUNTIME,"native","codexdc_windows_restart.node"));
    app.whenReady().then(()=>setTimeout(()=>{
      fs.writeFileSync(process.env.CODEXDC_TEST_RESULT,JSON.stringify({
        pid:process.pid,backend:process.env.CODEX_CLI_PATH,
        restartRegistration:restart.getRestartRegistration()
      }));
    },1600));
    app.on("quit",()=>{try{server.kill()}catch{}});
    setTimeout(()=>app.exit(0),6000);
  `);
  await asar.createPackage(fixture, join(resources, "app.asar"));
  setWindowsEmbeddedAsarIntegrity(join(root, "ChatGPT.exe"), readHeaderHash(join(resources, "app.asar")).headerHash);
  const resultFile = join(root, "result.json");
  child = spawn(join(root, "ChatGPT.exe"), [
    "--do-not-de-elevate", "--no-first-run", `--user-data-dir=${join(root, "profile")}`, "--restore-last-session", "--restart",
  ], {
    cwd: root,
    env: { ...process.env, CODEX_ELECTRON_USER_DATA_PATH: join(root, "profile"),
      CODEX_CLI_PATH: "C:\\obsolete\\codex.exe", CODEXDC_TEST_RESULT: resultFile },
    stdio: ["ignore", "ignore", "pipe"],
  });
  childClosed = new Promise(done => child.once("close", done));
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk; });
  const deadline = Date.now() + 15_000;
  while (!existsSync(resultFile)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture did not start: ${diagnostics}`);
    await new Promise(done => setTimeout(done, 100));
  }
  const result = JSON.parse(readFileSync(resultFile));
  assert.equal(result.pid, child.pid);
  assert.equal(result.backend, process.execPath);
  assert.equal(result.restartRegistration, null);
  const records = inspectWindowsProcesses().filter(row => row.pid === child.pid || row.parentPid === child.pid);
  const conflicts = findLaunchConflicts(records, {
    executable: join(root, "ChatGPT.exe"), backend: process.execPath,
    runtimeHash: desktopFingerprint(join(home, "runtime"), readFileSync(join(fixture, "codexdc-loader.cjs"))),
  }, pid => JSON.parse(readFileSync(join(home, "desktop-instances", `${pid}.json`))));
  assert.deepEqual(conflicts, []);
  const exitCode = await childClosed;
  assert.equal(exitCode, 0, diagnostics);
  assert.equal(existsSync(join(home, "desktop-instances", `${result.pid}.json`)), false);
  console.log(`Isolated Owl startup passed: saved backend, restart opt-out, loaded-runtime proof and reuse (${packageRoot}).`);
} finally {
  if (child && child.exitCode === null) {
    child.kill();
  }
  if (childClosed) await childClosed;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) unlinkSync(join(root, entry.name));
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
