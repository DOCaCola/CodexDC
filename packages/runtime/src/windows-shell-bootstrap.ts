import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type Logger = (level: "info" | "warn" | "error", ...args: unknown[]) => void;
type PersistedPathReader = (systemRoot: string) => WindowsPersistedPathSnapshot | null;

export interface WindowsPersistedPathSnapshot {
  machine: string;
  user: string;
}

export interface WindowsShellBootstrapOptions {
  codexConfigPath?: string;
  readPersistedPath?: PersistedPathReader;
}

function trimWrappedQuotes(value: string | undefined | null): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function parseQuotedTomlString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== `"` && quote !== `'`) || trimmed[trimmed.length - 1] !== quote) {
    return null;
  }

  const inner = trimmed.slice(1, -1);
  if (quote === `'`) return inner;

  return inner.replace(/\\(["\\btnrf])/g, (_match, escape: string) => {
    switch (escape) {
      case `b`: return "\b";
      case `t`: return "\t";
      case `n`: return "\n";
      case `r`: return "\r";
      case `f`: return "\f";
      default: return escape;
    }
  });
}

function readShellEnvironmentPolicy(configPath: string | undefined): Record<string, string> {
  if (!configPath || !existsSync(configPath)) return {};

  try {
    const source = readFileSync(configPath, "utf8");
    const lines = source.split(/\r?\n/);
    const policy: Record<string, string> = {};
    let inShellEnvironmentPolicySet = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const sectionMatch = /^\[(.+)\]$/.exec(line);
      if (sectionMatch) {
        inShellEnvironmentPolicySet = sectionMatch[1]?.trim() === "shell_environment_policy.set";
        continue;
      }

      if (!inShellEnvironmentPolicySet) continue;

      const assignmentMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
      if (!assignmentMatch) continue;

      const key = assignmentMatch[1];
      const parsedValue = parseQuotedTomlString(assignmentMatch[2] ?? "");
      if (!key || parsedValue == null) continue;
      policy[key] = parsedValue;
    }

    return policy;
  } catch {
    return {};
  }
}

function splitPathEntries(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(";")
    .map((entry) => trimWrappedQuotes(entry))
    .filter((entry) => entry.length > 0);
}

function splitPosixPathEntries(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(":")
    .map((entry) => trimWrappedQuotes(entry))
    .filter((entry) => entry.length > 0);
}

function mergeUniquePathEntries(primary: string[], secondary: string[]): string[] {
  const combined: string[] = [];
  const seen = new Set<string>();

  for (const entry of [...primary, ...secondary]) {
    if (!entry) continue;
    const normalized = entry.trim();
    if (!normalized) continue;
    const lowered = normalized.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    combined.push(normalized);
  }

  return combined;
}

function setProcessPath(entries: string[]): void {
  const joined = entries.join(";");
  process.env.Path = joined;
  process.env.PATH = joined;
}

function prependUniquePathEntries(entries: string[]): void {
  setProcessPath(mergeUniquePathEntries(entries, splitPathEntries(process.env.Path || process.env.PATH || "")));
}

function appendUniquePathEntries(entries: string[]): void {
  setProcessPath(mergeUniquePathEntries(splitPathEntries(process.env.Path || process.env.PATH || ""), entries));
}

function resolvePreferredShell(): string | null {
  const requestedShell = trimWrappedQuotes(process.env.SHELL || "");
  if (requestedShell && existsSync(requestedShell)) {
    return requestedShell;
  }

  const candidates = [
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\msys64\\bin\\bash.exe",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return requestedShell || null;
}

function resolveMsysRoot(shellPath: string | null): string {
  if (shellPath) {
    const normalizedShellPath = normalizeWindowsPathEntry(shellPath);
    if (normalizedShellPath.endsWith("\\usr\\bin\\bash.exe")) {
      return dirname(dirname(dirname(shellPath)));
    }
    if (normalizedShellPath.endsWith("\\bin\\bash.exe")) {
      return dirname(dirname(shellPath));
    }
  }

  return "C:\\msys64";
}

function looksLikeInheritedPosixPath(value: string | undefined | null): boolean {
  if (!value) return false;
  if (value.includes(";")) return false;
  return /(^|:)\//.test(value);
}

function convertPosixPathEntryToWindows(
  entry: string,
  shellPath: string | null,
): string {
  if (!entry.startsWith("/")) return entry;

  const segments = entry.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return entry;

  const driveMatch = /^[a-zA-Z]$/.exec(segments[0] ?? "");
  if (driveMatch) {
    const drive = `${driveMatch[0].toUpperCase()}:`;
    return segments.length === 1 ? `${drive}\\` : join(drive, ...segments.slice(1));
  }

  const msysRoot = resolveMsysRoot(shellPath);
  if ((segments[0] ?? "") === "bin") {
    return join(msysRoot, "usr", "bin", ...segments.slice(1));
  }

  return join(msysRoot, ...segments);
}

function normalizeInheritedWindowsPath(shellPath: string | null): void {
  const currentPath = process.env.Path || process.env.PATH || "";
  if (!looksLikeInheritedPosixPath(currentPath)) {
    return;
  }

  const normalizedEntries = mergeUniquePathEntries(
    splitPosixPathEntries(currentPath).map((entry) => convertPosixPathEntryToWindows(entry, shellPath)),
    [],
  );

  if (normalizedEntries.length === 0) {
    return;
  }

  setProcessPath(normalizedEntries);
}

function normalizeWindowsPathEntry(entry: string): string {
  return entry.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
}

function isCorePathEntry(entry: string, shellPath: string | null, systemRoot: string): boolean {
  const normalized = normalizeWindowsPathEntry(entry);
  const shellDir = shellPath ? normalizeWindowsPathEntry(dirname(shellPath)) : null;
  const shellRoot = shellPath ? normalizeWindowsPathEntry(dirname(dirname(shellPath))) : null;
  const systemEntries = new Set([
    normalizeWindowsPathEntry(systemRoot),
    normalizeWindowsPathEntry(join(systemRoot, "System32")),
    normalizeWindowsPathEntry(join(systemRoot, "System32", "Wbem")),
    normalizeWindowsPathEntry(join(systemRoot, "System32", "WindowsPowerShell", "v1.0")),
  ]);

  return normalized === shellDir || normalized === shellRoot || systemEntries.has(normalized);
}

function expandWindowsEnvironmentVariables(value: string): string {
  if (!value.includes("%")) return value;

  const envMap = new Map(
    Object.entries(process.env).map(([key, envValue]) => [key.toLowerCase(), envValue ?? ""] as const),
  );

  return value.replace(/%([^%]+)%/g, (match, variableName: string) => envMap.get(variableName.toLowerCase()) ?? match);
}

function readPersistedWindowsPath(systemRoot: string): WindowsPersistedPathSnapshot | null {
  const powershellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(powershellPath)) {
    try {
      const output = execFileSync(
        powershellPath,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @{ machine = [Environment]::GetEnvironmentVariable('Path','Machine'); user = [Environment]::GetEnvironmentVariable('Path','User') } | ConvertTo-Json -Compress",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        },
      ).trim();
      if (output) {
        const parsed = JSON.parse(output) as Partial<WindowsPersistedPathSnapshot>;
        return {
          machine: typeof parsed.machine === "string" ? parsed.machine : "",
          user: typeof parsed.user === "string" ? parsed.user : "",
        };
      }
    } catch {
      // Fall back to registry reads below.
    }
  }

  const machine = readRegistryPathValue(
    systemRoot,
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "Path",
  );
  const user = readRegistryPathValue(systemRoot, "HKCU\\Environment", "Path");

  if (machine == null && user == null) return null;
  return {
    machine: machine ?? "",
    user: user ?? "",
  };
}

function readRegistryPathValue(
  systemRoot: string,
  keyPath: string,
  valueName: string,
): string | null {
  const regPath = join(systemRoot, "System32", "reg.exe");
  if (!existsSync(regPath)) return null;

  try {
    const output = execFileSync(
      regPath,
      ["query", keyPath, "/v", valueName],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );

    const pattern = new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_[A-Z_]+\\s+(.*)$`, "im");
    const match = pattern.exec(output);
    if (!match) return null;

    const value = match[1]?.trim() ?? "";
    return value.length > 0 ? value : "";
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergePersistedWindowsPathEntries(
  shellPath: string | null,
  systemRoot: string,
  readPersistedPath: PersistedPathReader,
): { matched: number; merged: number; missing: number } {
  const persisted = readPersistedPath(systemRoot);
  if (!persisted) {
    return { matched: 0, merged: 0, missing: 0 };
  }

  const currentEntries = splitPathEntries(process.env.Path || process.env.PATH || "");
  const currentSet = new Set(currentEntries.map(normalizeWindowsPathEntry));
  const persistedEntries = mergeUniquePathEntries(
    splitPathEntries(persisted.machine).map(expandWindowsEnvironmentVariables),
    splitPathEntries(persisted.user).map(expandWindowsEnvironmentVariables),
  ).filter((entry) => !isCorePathEntry(entry, shellPath, systemRoot));

  if (persistedEntries.length === 0) {
    return { matched: 0, merged: 0, missing: 0 };
  }

  const missingEntries = persistedEntries.filter((entry) => !currentSet.has(normalizeWindowsPathEntry(entry)));
  const matched = persistedEntries.length - missingEntries.length;
  const looksTrimmed =
    missingEntries.length >= Math.max(3, Math.ceil(persistedEntries.length / 3)) ||
    (matched === 0 && missingEntries.length > 0);

  if (!looksTrimmed || missingEntries.length === 0) {
    return { matched, merged: 0, missing: missingEntries.length };
  }

  appendUniquePathEntries(missingEntries);
  return { matched, merged: missingEntries.length, missing: missingEntries.length };
}

function ensureGitOnPath(): void {
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "cmd", "git.exe") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "bin", "git.exe") : null,
    programFilesX86 ? join(programFilesX86, "Git", "cmd", "git.exe") : null,
    programFilesX86 ? join(programFilesX86, "Git", "bin", "git.exe") : null,
  ].filter((value): value is string => Boolean(value && existsSync(value)));

  if (candidates.length === 0) return;

  prependUniquePathEntries([dirname(candidates[0])]);

  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return;

  const normalizedHome = process.env.HOME
    ? process.env.HOME.replace(/\//g, "\\").replace(/\\+$/g, "")
    : null;
  const normalizedUserProfile = userProfile.replace(/\//g, "\\").replace(/\\+$/g, "");
  const msysHomeRoot = join(process.env.SystemDrive || "C:", "msys64", "home")
    .replace(/\//g, "\\")
    .replace(/\\+$/g, "");

  if (!normalizedHome || normalizedHome.toLowerCase().startsWith(msysHomeRoot.toLowerCase())) {
    process.env.HOME = normalizedUserProfile;
  }
}

export function applyWindowsShellBootstrap(log: Logger, options: WindowsShellBootstrapOptions = {}): void {
  if (process.platform !== "win32") {
    return;
  }

  const shellPath = resolvePreferredShell();
  normalizeInheritedWindowsPath(shellPath);
  const shellEnvironmentPolicy = readShellEnvironmentPolicy(options.codexConfigPath);
  const systemRoot = process.env.SystemRoot && process.env.SystemRoot.length > 0
    ? process.env.SystemRoot
    : "C:\\Windows";

  const baseEntries = [
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    shellPath ? dirname(shellPath) : null,
    shellPath ? dirname(dirname(shellPath)) : null,
  ].filter((entry): entry is string => Boolean(entry && existsSync(entry)));

  if (shellPath) {
    process.env.SHELL = shellPath;
    const msystem = shellEnvironmentPolicy.MSYSTEM;
    const chereInvoking = shellEnvironmentPolicy.CHERE_INVOKING;
    const msys2PathType = shellEnvironmentPolicy.MSYS2_PATH_TYPE;
    if (msystem) process.env.MSYSTEM = msystem;
    if (chereInvoking) process.env.CHERE_INVOKING = chereInvoking;
    if (msys2PathType) process.env.MSYS2_PATH_TYPE = msys2PathType;
  }

  const defaultComSpec = join(systemRoot, "System32", "cmd.exe");
  if ((!process.env.COMSPEC || process.env.COMSPEC.length === 0) && existsSync(defaultComSpec)) {
    process.env.COMSPEC = defaultComSpec;
  }

  const persistedPathMerge = mergePersistedWindowsPathEntries(
    shellPath,
    systemRoot,
    options.readPersistedPath ?? readPersistedWindowsPath,
  );
  prependUniquePathEntries(baseEntries);
  ensureGitOnPath();

  log("info", "windows shell bootstrap applied", {
    shell: process.env.SHELL || null,
    msystem: process.env.MSYSTEM || null,
    chereInvoking: process.env.CHERE_INVOKING || null,
    home: process.env.HOME || homedir(),
    mergedPersistedPathEntries: persistedPathMerge.merged,
  });
}
