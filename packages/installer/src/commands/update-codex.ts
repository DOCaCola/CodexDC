import { execFileSync } from "node:child_process";
import { userPaths } from "../paths.js";
import { readState } from "../state.js";

/** Only the official installation runs its publisher-provided updater. */
export async function updateCodex(_opts: { app?: string } = {}): Promise<void> {
  if (process.platform !== "darwin") throw new Error("On Windows, update official Codex through Microsoft Store, then refresh CodexDC.");
  const state = readState(userPaths().stateFile);
  if (!state?.managedCopy || !state.officialAppRoot) throw new Error("Install a managed CodexDC app first.");
  execFileSync("open", [state.officialAppRoot], { stdio: "ignore" });
  console.log("Update official Codex using its menu, close both apps, then launch CodexDC to refresh its managed copy.");
}
