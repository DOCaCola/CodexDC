/** Shared desktop/launcher selection rules. Kept separate from the renderer SDK. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BackendSelection {
  provider: "bundled" | "fork" | "development";
  installed?: { executable: string };
  development?: { executable: string };
}

export function backendEnvironment(state: BackendSelection, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.CODEX_CLI_PATH;
  switch (state.provider) {
    case "bundled": break;
    case "fork":
      if (!state.installed || !existsSync(state.installed.executable)) {
        throw new Error("The selected DC fork CLI is missing. Reinstall it or explicitly select the desktop-bundled CLI.");
      }
      env.CODEX_CLI_PATH = state.installed.executable;
      break;
    case "development":
      if (!state.development || !existsSync(state.development.executable)) {
        throw new Error("The local CLI is missing. Rebuild it or select another CLI backend.");
      }
      env.CODEX_CLI_PATH = state.development.executable;
      break;
    default: throw new Error("Invalid CLI backend selection");
  }
  return env;
}

export function savedBackendEnvironment(root: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const state = JSON.parse(readFileSync(join(root, "backend.json"), "utf8")) as BackendSelection;
  return backendEnvironment(state, inherited);
}
