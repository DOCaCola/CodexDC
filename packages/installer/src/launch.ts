import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { backendEnvironment, backendState } from "./backend.js";
import { userPaths } from "./paths.js";
import { readState } from "./state.js";
import { resolveWindowsExecutable } from "./platform.js";

export async function launchManaged(): Promise<void> {
  const paths = userPaths();
  const state = readState(paths.stateFile);
  if (!state) throw new Error("Install CodexDC first.");
  const env = backendEnvironment(backendState(), process.env);
  if (process.platform === "darwin") {
    // The native managed launcher also resolves the selection for Finder/Dock.
    execFileSync("open", [state.appRoot], { env, stdio: "ignore" });
    return;
  }
  const executable = resolveWindowsExecutable(state.appRoot);
  if (!existsSync(executable)) throw new Error("Managed desktop is missing; run Repair.");
  env.CODEXDC_APP_USER_MODEL_ID = state.appUserModelId ?? "DOCaCola.CodexDC";
  const child = spawn(executable, [], { env, cwd: dirname(executable), detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
