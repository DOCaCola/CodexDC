import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backendEnvironment, backendState } from "./backend.js";
import { userPaths } from "./paths.js";
import { readState } from "./state.js";
import { resolveWindowsExecutable } from "./platform.js";
import { maintainBeforeLaunch } from "./launch-maintenance.js";

export async function launchManaged(): Promise<void> {
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
  const env = backendEnvironment(backendState(), process.env);
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
  const child = spawn(executable, args, { env, cwd: dirname(executable), detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
