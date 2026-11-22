import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import kleur from "kleur";
import { backendEnvironment, prepareBackend, type BackendState } from "./backend.js";
import { userPaths } from "./paths.js";
import { readState } from "./state.js";
import { resolveWindowsExecutable } from "./platform.js";
import { maintainBeforeLaunch } from "./launch-maintenance.js";
import { launchMacDesktop } from "./mac-desktop-launch.js";
import { launchWindowsDesktop } from "./windows-desktop-launch.js";
import { waitForProcessExit } from "./commands/repair-after-exit.js";
import { CODEXDC_VERSION } from "./version.js";
import { guardWindowsLaunch } from "./windows-launch-guard.js";
import { logWindowsLaunch, withWindowsLaunchDiagnostics } from "./windows-launch-diagnostics.js";

export async function launchManaged(): Promise<void> {
  if (process.platform === "win32") return withWindowsLaunchDiagnostics(launchManagedDesktop);
  return launchManagedDesktop();
}

async function launchManagedDesktop(): Promise<void> {
  console.log(kleur.bold(`CodexDC ${CODEXDC_VERSION}`));
  if (process.platform === "win32") {
    const paths = userPaths();
    const state = readState(paths.stateFile);
    if (!state) throw new Error("Install CodexDC first.");
    logWindowsLaunch("Checking running desktop, backend and elevation");
    if (!guardWindowsLaunch(state, await prepareBackend(), paths.root)) {
      logWindowsLaunch("Launch cancelled");
      return;
    }
    logWindowsLaunch("Launch guard completed; starting maintenance");
  }
  const checkForUpdate = process.env.CODEXDC_LAUNCH_CHECKED !== "1";
  if (process.platform === "darwin" && checkForUpdate && process.env.CODEXDC_LAUNCH_PARENT !== undefined) {
    const pid = Number(process.env.CODEXDC_LAUNCH_PARENT);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid launch parent process id");
    await waitForProcessExit(pid, { timeoutMs: 30_000 });
  }
  const next = await maintainBeforeLaunch(checkForUpdate);
  if (next) {
    const result = spawnSync(next.node,
      [join(next.root, "packages", "installer", "dist", "cli.js"), "launch"],
      { env: { ...process.env, CODEXDC_LAUNCH_CHECKED: "1" }, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`Launch maintenance stopped (${result.signal}).`);
    // The new maintenance process reports its own launch errors.
    process.exitCode = result.status;
    return;
  }
  const paths = userPaths();
  const state = readState(paths.stateFile);
  if (!state) throw new Error("Install CodexDC first.");
  const backend = await prepareBackend();
  if (process.platform === "win32") logWindowsLaunch("Maintenance completed; preparing the desktop launch");
  console.log(`CLI backend: ${describeBackend(backend)}`);
  const env = backendEnvironment(backend, process.env);
  const executable = process.platform === "darwin"
    ? join(state.appRoot, "Contents", "MacOS", JSON.parse(readFileSync(
      join(state.appRoot, "Contents", "Resources", "codexdc-launch.json"), "utf8")).originalExecutable)
    : resolveWindowsExecutable(state.appRoot);
  if (!existsSync(executable)) throw new Error("Managed desktop is missing; run Repair.");
  env.CODEXDC_APP_USER_MODEL_ID = state.appUserModelId ?? "DOCaCola.CodexDC";
  const args = JSON.parse(process.env.CODEXDC_DESKTOP_ARGS ?? "[]") as string[];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new Error("Invalid desktop launch arguments");
  delete env.CODEXDC_DESKTOP_ARGS;
  delete env.CODEXDC_LAUNCH_CHECKED;
  delete env.CODEXDC_LAUNCH_PARENT;
  console.log(`Starting desktop${state.codexVersion ? ` (Codex ${state.codexVersion})` : ""}: ${state.appRoot}`);
  if (process.platform === "darwin") {
    launchMacDesktop(state.appRoot, args, env);
    return;
  }
  const child = process.platform === "win32"
    ? launchWindowsDesktop(executable, args, env)
    : spawn(executable, args, { env, cwd: dirname(executable), detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  if (process.platform === "win32") logWindowsLaunch(`Desktop spawned: PID ${child.pid}, executable ${executable}`);
  child.unref();
}

function describeBackend(state: BackendState): string {
  switch (state.provider) {
    case "fork": return `DC fork ${state.installed!.tag}`;
    case "bundled": return "desktop bundled";
    case "development": return `local ${state.development!.executable} (${state.development!.version})`;
  }
}
