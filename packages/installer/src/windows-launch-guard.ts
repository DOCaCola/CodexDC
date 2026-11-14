import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import type { InstallerState } from "./state.js";
import { backendEnvironment, type BackendState } from "./backend.js";
import { resolveWindowsExecutable } from "./platform.js";
import { desktopFingerprint } from "@codexdc/sdk/dist/desktop-fingerprint.js";

export interface DesktopProcess {
  pid: number;
  parentPid: number;
  executable: string;
  commandLine: string;
  startedAt: string;
  name: string;
}

interface LoadedDesktop {
  pid: number;
  executable: string;
  reportedAt: string;
  runtimeHash: string;
}

export interface LaunchConflict {
  process: DesktopProcess;
  reason: string;
}

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const nativeGuard = (action: string, extraEnv: NodeJS.ProcessEnv = {}) => execFileSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
  "-File", join(assets, "windows-launch-guard.ps1"), action,
], {
  env: { ...process.env, ...extraEnv }, encoding: "utf8", windowsHide: true,
  // The user controls how long the confirmation dialog stays open.
  ...(action === "confirm" ? {} : { timeout: 30_000 }), maxBuffer: 4 * 1024 * 1024,
}).trim();

export function inspectWindowsProcesses(): DesktopProcess[] {
  const rows: unknown = JSON.parse(nativeGuard("inspect"));
  if (!Array.isArray(rows)) throw new Error("Could not inspect running Codex instances.");
  return rows as DesktopProcess[];
}

const samePath = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

function isCodexDesktop(file: string): boolean {
  if (!/^(?:chatgpt|codex)\.exe$/i.test(win32.basename(file))) return false;
  const archive = join(dirname(file), "resources", "app.asar");
  if (!existsSync(archive)) return false;
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString());
  return pkg.name === "openai-codex-electron";
}

export function findLaunchConflicts(
  processes: DesktopProcess[],
  expected: { executable: string; backend: string; runtimeHash: string },
  readLoaded: (pid: number) => LoadedDesktop | null,
  identifyDesktop: (executable: string) => boolean = isCodexDesktop,
): LaunchConflict[] {
  const result: LaunchConflict[] = [];
  for (const proc of processes) {
    if (/(?:^|\s)--type=/.test(proc.commandLine)) continue;
    const parent = processes.find(row => row.pid === proc.parentPid);
    // Sandboxed browser helpers can hide their path from CIM.
    if (parent && ((proc.executable && samePath(parent.executable, proc.executable)) ||
        (!proc.executable && parent.executable && parent.name === proc.name))) continue;
    if (!proc.executable && /^(?:chatgpt|codex)\.exe$/i.test(proc.name)) {
      throw new Error("A running Codex process cannot be inspected. Start CodexDC with the same privileges as that instance, or close it manually.");
    }
    if (!proc.executable) continue;
    if (!samePath(proc.executable, expected.executable) && !identifyDesktop(proc.executable)) continue;
    let reason: string | null = null;
    if (!samePath(proc.executable, expected.executable)) {
      reason = "Another Codex desktop is open.";
    } else {
      const loaded = readLoaded(proc.pid);
      if (!loaded || loaded.pid !== proc.pid || !samePath(loaded.executable, proc.executable) ||
          !Number.isFinite(Date.parse(loaded.reportedAt)) || Date.parse(loaded.reportedAt) < Date.parse(proc.startedAt)) {
        reason = "The running instance cannot confirm that it loaded the CodexDC startup patch.";
      } else if (loaded.runtimeHash !== expected.runtimeHash) {
        reason = "The running instance loaded a different CodexDC runtime.";
      } else {
        const servers = processes.filter(row => row.parentPid === proc.pid &&
          /(?:^|\s)app-server(?:\s|$)/.test(row.commandLine) && !/(?:^|\s)--managed-daemon(?:\s|$)/.test(row.commandLine));
        if (servers.length !== 1 || !samePath(servers[0]!.executable, expected.backend)) {
          reason = "The running instance is using a different CLI backend, or its backend cannot be verified.";
        }
      }
    }
    if (reason) result.push({ process: proc, reason });
  }
  return result;
}

const services = {
  inspect: inspectWindowsProcesses,
  confirm: (conflicts: LaunchConflict[]) => nativeGuard("confirm", {
    CODEXDC_LAUNCH_WARNING: [
      "CodexDC needs to replace an existing Codex instance before starting.",
      ...conflicts.map(item => `${item.reason} (PID ${item.process.pid})`),
      "",
      "It cannot confirm that the instance is safe to close. Killing it interrupts active tasks and may lose unsent input.",
      "",
      "Kill the running instance and start CodexDC, or cancel?",
    ].join("\n"),
  }) === "kill",
  kill: (conflicts: LaunchConflict[]) => {
    nativeGuard("kill", { CODEXDC_LAUNCH_TARGETS: JSON.stringify(conflicts.map(item => item.process)) });
  },
  readLoaded: (root: string, pid: number): LoadedDesktop | null => {
    const file = join(root, "desktop-instances", `${pid}.json`);
    if (!existsSync(file)) return null;
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      return value && typeof value.pid === "number" && typeof value.executable === "string" &&
        typeof value.reportedAt === "string" && typeof value.runtimeHash === "string" ? value : null;
    } catch { return null; } // An unreadable proof means unknown, never permission to kill.
  },
  identifyDesktop: isCodexDesktop,
};

/** Always obtain an explicit choice before terminating an uncertain instance. */
export function guardWindowsLaunch(
  state: InstallerState,
  backend: BackendState,
  userRoot: string,
  deps = services,
): boolean {
  const executable = resolveWindowsExecutable(state.appRoot);
  const expected = {
    executable,
    backend: backendEnvironment(backend, {}).CODEX_CLI_PATH ?? join(state.appRoot, "resources", "codex.exe"),
    runtimeHash: desktopFingerprint(join(assets, "runtime"), readFileSync(join(assets, "loader.cjs"))),
  };
  const find = () => findLaunchConflicts(deps.inspect(), expected, pid => deps.readLoaded(userRoot, pid), deps.identifyDesktop);
  const conflicts = find();
  if (!conflicts.length) return true;
  if (!deps.confirm(conflicts)) return false;
  deps.kill(conflicts);
  // A new instance appearing during the dialog is not covered by that consent.
  if (find().length) throw new Error("A conflicting Codex instance is still running. Launch cancelled; try again.");
  return true;
}
