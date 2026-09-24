import { appendFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureUserPaths } from "../paths.js";
import { resolveWindowsExecutable } from "../platform.js";
import { readState } from "../state.js";
import { installNewStorePackage } from "../windows-store-update.js";
import { backendEnvironment, backendState } from "../backend.js";
import { repair } from "./repair.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 250;
const LAUNCH_GRACE_MS = 2_000;

interface RepairAfterExitOptions {
  pid?: string | number;
  "store-family"?: string;
  "store-version"?: string;
}

interface WaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  isRunning?: (pid: number) => boolean;
  onProgress?: (message: string) => void;
  progressIntervalMs?: number;
}

export async function repairAfterExit(opts: RepairAfterExitOptions = {}): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("repair-after-exit is only supported on Windows");
  }

  const pid = parseProcessId(opts.pid);
  const storeFamily = opts["store-family"];
  const storeVersion = opts["store-version"];
  if (Boolean(storeFamily) !== Boolean(storeVersion)) {
    throw new Error("Store update requires both --store-family and --store-version");
  }
  const paths = ensureUserPaths();
  const logPath = join(paths.logDir, "windows-store-update.log");
  const writeLog = (message: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log(line);
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  };

  try {
    writeLog(`Update details are also saved to ${logPath}`);
    writeLog(`Waiting for CodexDC process ${pid} to exit`);
    await waitForProcessExit(pid, { onProgress: writeLog });
    writeLog("CodexDC has exited");
    if (storeFamily && storeVersion) {
      writeLog(`Requesting Windows Store update for ${storeFamily} after ${storeVersion}`);
      const installed = await installNewStorePackage(storeFamily, storeVersion, writeLog);
      writeLog(`Windows Store installed ${storeFamily} ${installed.version}`);
    }
    writeLog("Starting forced repair against the current Windows Store package");
    await repair({ force: true });
    writeLog("Forced repair finished; checking the patched executable");

    const state = readState(paths.stateFile);
    if (!state) throw new Error("CodexDC installer state is missing after repair");
    const executable = resolveWindowsExecutable(state.appRoot);
    if (!existsSync(executable)) {
      throw new Error(`Patched Codex executable was not found: ${executable}`);
    }

    const child = spawn(executable, [], {
      cwd: dirname(executable),
      detached: true,
      env: {
        ...backendEnvironment(backendState(), process.env),
        ...(state.appUserModelId
          ? { CODEXDC_APP_USER_MODEL_ID: state.appUserModelId }
          : {}),
      },
      stdio: "ignore",
    });
    await waitForSuccessfulLaunch(child);
    child.unref();
    writeLog(`Repair completed; relaunched ${executable}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLog(`Repair failed: ${error instanceof Error ? error.stack ?? error.message : message}`);
    showWindowsStoreUpdateFailure(message, logPath);
    throw error;
  }
}

function showWindowsStoreUpdateFailure(message: string, logPath: string): void {
  const command = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$message = [Environment]::GetEnvironmentVariable('CODEXPP_UPDATE_ERROR');",
    "[System.Windows.Forms.MessageBox]::Show(",
    "$message, 'CodexDC update failed',",
    "[System.Windows.Forms.MessageBoxButtons]::OK,",
    "[System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null",
  ].join(" ");
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      {
        env: {
          ...process.env,
          CODEXPP_UPDATE_ERROR: `${message}\n\nDetails: ${logPath}\n\nThe previous CodexDC shortcut remains available if the new patch did not complete.`,
        },
        windowsHide: true,
        timeout: 120_000,
        stdio: "ignore",
      },
    );
  } catch {
    // The failure is already recorded in the helper log.
  }
}

export async function waitForSuccessfulLaunch(
  child: ChildProcess,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? LAUNCH_GRACE_MS;
  if (child.exitCode !== null) {
    throw launchExitError(child.exitCode, child.signalCode);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, graceMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(launchExitError(code, signal));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function launchExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
): Error {
  const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
  return new Error(`Patched Codex exited during startup validation (${detail})`);
}

export function parseProcessId(value: string | number | undefined): number {
  const pid = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id: ${String(value ?? "")}`);
  }
  return pid;
}

export async function waitForProcessExit(pid: number, opts: WaitOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const isRunning = opts.isRunning ?? isProcessRunning;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  while (isRunning(pid)) {
    const now = Date.now();
    if (now - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for process ${pid} to exit`);
    }
    if (opts.onProgress && now - lastProgressAt >= (opts.progressIntervalMs ?? 15_000)) {
      opts.onProgress(`Still waiting for CodexDC process ${pid} to exit (${Math.floor((now - startedAt) / 1_000)}s)`);
      lastProgressAt = now;
    }
    await delay(pollIntervalMs);
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
