import { spawn, execFileSync } from "node:child_process";
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

export async function launchManaged(): Promise<void> {
  console.log(kleur.bold(`CodexDC ${CODEXDC_VERSION}`));
  if (process.platform === "darwin" && process.env.CODEXDC_LAUNCH_PARENT !== undefined) {
    const pid = Number(process.env.CODEXDC_LAUNCH_PARENT);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid launch parent process id");
    delete process.env.CODEXDC_LAUNCH_PARENT;
    await waitForProcessExit(pid, { timeoutMs: 30_000 });
  }
  const next = await maintainBeforeLaunch(process.env.CODEXDC_LAUNCH_CHECKED !== "1");
  if (next) {
    execFileSync(join(next, "node", process.platform === "win32" ? "node.exe" : "node"),
      [join(next, "packages", "installer", "dist", "cli.js"), "launch"],
      { env: { ...process.env, CODEXDC_LAUNCH_CHECKED: "1" }, stdio: "inherit" });
    return;
  }
  const paths = userPaths();
  const state = readState(paths.stateFile);
  if (!state) throw new Error("Install CodexDC first.");
  const backend = await prepareBackend();
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
  console.log(`Starting desktop${state.codexVersion ? ` (Codex ${state.codexVersion})` : ""}: ${state.appRoot}`);
  if (process.platform === "darwin") {
    launchMacDesktop(state.appRoot, args, env);
    return;
  }
  const child = process.platform === "win32"
    ? launchWindowsDesktop(executable, args, env)
    : spawn(executable, args, { env, cwd: dirname(executable), detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}

function describeBackend(state: BackendState): string {
  switch (state.provider) {
    case "fork": return `DC fork ${state.installed!.tag}`;
    case "bundled": return "desktop bundled";
    case "development": return `local ${state.development!.executable} (${state.development!.version})`;
  }
}
