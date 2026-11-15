import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { userPaths } from "./paths.js";
import { capLogFile } from "./logging.js";
import { windowsGuardProcessOptions } from "./windows-launch-guard.js";

export function logWindowsLaunch(message: string): void {
  const paths = userPaths();
  mkdirSync(paths.logDir, { recursive: true });
  const file = join(paths.logDir, "launch.log");
  capLogFile(file);
  appendFileSync(file, `[${new Date().toISOString()}] [launcher ${process.pid}] ${message}\n`);
}

const diagnostics = {
  log: logWindowsLaunch,
  showError: (message: string) => {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File",
      fileURLToPath(new URL("../assets/windows-launch-guard.ps1", import.meta.url)), "error",
    ], windowsGuardProcessOptions("error", {
      CODEXDC_LAUNCH_ERROR: `${message}\n\nDetails: ${join(userPaths().logDir, "launch.log")}`,
    }));
  },
  reportDisplayFailure: (error: unknown) => console.error("Could not display the CodexDC launch error:", error),
};

/** A shortcut's console disappears on exit; retain errors and show them first. */
export async function withWindowsLaunchDiagnostics(action: () => Promise<void>, deps = diagnostics): Promise<void> {
  try {
    deps.log("Launch requested");
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { deps.log(`Launch failed: ${error instanceof Error ? error.stack ?? message : message}`); }
    catch (loggingError) { console.error("Could not save the launch diagnostic:", loggingError); }
    try { deps.showError(message); }
    catch (displayError) { deps.reportDisplayFailure(displayError); }
    throw error;
  }
}
