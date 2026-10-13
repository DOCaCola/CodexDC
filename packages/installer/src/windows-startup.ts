import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexInstall } from "./platform.js";
import { managedStorePackageRoot } from "./windows-store-mirror-retention.js";

export interface WindowsStartupTask {
  taskId: string;
  state: number;
  changed: boolean;
}

const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "windows-startup.ps1");

/** The managed mirror retains the official package's full name, not our app ID. */
export function officialWindowsPackageFamily(codex: CodexInstall): string | null {
  if (codex.platform !== "win32") return null;
  const root = managedStorePackageRoot(codex.appRoot);
  if (!root) return null;
  const match = /^([A-Za-z0-9.-]+)_\d+(?:\.\d+){3}_[A-Za-z0-9]+_[A-Za-z0-9.-]*_([A-Za-z0-9]+)$/.exec(basename(root));
  if (!match) throw new Error(`Invalid managed Windows Store package name: ${basename(root)}`);
  return `${match[1]}_${match[2]}`;
}

export function officialWindowsStartupTasks(codex: CodexInstall, disable = false): WindowsStartupTask[] {
  const family = officialWindowsPackageFamily(codex);
  if (!family) return [];
  const output = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-PackageFamily", family, "-Mode", disable ? "disable" : "query",
  ], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return JSON.parse(output) as WindowsStartupTask[];
}

export function officialWindowsStartupCheck(tasks: WindowsStartupTask[]): { ok: boolean | "warn"; detail: string } {
  const enabled = tasks.filter(task => task.state === 2 || task.state === 4);
  if (enabled.length) {
    return {
      ok: "warn",
      detail: `official Store app starts at login (${enabled.map(task => task.taskId).join(", ")}) and can intercept CodexDC's first launch; run \`codexdc repair\` or disable it in Windows Startup apps${enabled.some(task => task.state === 4) ? "; enabled by policy — contact your administrator" : ""}`,
    };
  }
  return { ok: true, detail: tasks.length ? "official Store app automatic startup is disabled" : "official Store app has no registered startup tasks" };
}
