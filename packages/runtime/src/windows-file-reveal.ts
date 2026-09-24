import { existsSync, statSync } from "node:fs";
import { win32 } from "node:path";

interface ShellLike {
  showItemInFolder(path: string): void;
  openPath(path: string): Promise<string>;
}

interface ChildProcessLike {
  once?(event: "error", listener: (error: Error) => void): unknown;
  unref?(): void;
}

interface WindowsFileRevealOptions {
  shell: ShellLike;
  spawn(
    executable: string,
    args: string[],
    options: { detached: boolean; stdio: "ignore"; windowsHide: boolean },
  ): ChildProcessLike;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pathExists?(path: string): boolean;
  pathStat?(path: string): { isDirectory(): boolean };
  logWarning?(message: string, error: unknown): void;
}

export interface WindowsFileRevealOverrideResult {
  installed: boolean;
  directoryOpusRuntime: string | null;
}

export function installWindowsFileRevealOverride(
  options: WindowsFileRevealOptions,
): WindowsFileRevealOverrideResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { installed: false, directoryOpusRuntime: null };

  const directoryOpusRuntime = resolveDirectoryOpusRuntime(
    options.env ?? process.env,
    options.pathExists ?? existsSync,
  );
  if (directoryOpusRuntime == null) {
    return { installed: false, directoryOpusRuntime: null };
  }

  const pathStat = options.pathStat ?? statSync;
  const stockOpenPath = options.shell.openPath.bind(options.shell);
  options.shell.showItemInFolder = (path: string) => {
    try {
      const normalized = win32.resolve(path);
      launchDirectoryOpus(
        directoryOpusRuntime,
        normalized,
        pathStat(normalized).isDirectory(),
        options,
      );
    } catch (error) {
      options.logWarning?.(`Directory Opus reveal failed for ${path}`, error);
    }
  };
  options.shell.openPath = async (path: string) => {
    try {
      const normalized = win32.resolve(path);
      if (!pathStat(normalized).isDirectory()) return stockOpenPath(path);
      launchDirectoryOpus(directoryOpusRuntime, normalized, true, options);
      return "";
    } catch (error) {
      options.logWarning?.(`Directory Opus directory open failed for ${path}`, error);
      return stockOpenPath(path);
    }
  };

  return { installed: true, directoryOpusRuntime };
}

function launchDirectoryOpus(
  directoryOpusRuntime: string,
  path: string,
  isDirectory: boolean,
  options: WindowsFileRevealOptions,
): void {
  const args = isDirectory
    ? ["/acmd", "Go", path, "TOFRONT"]
    : ["/acmd", "Go", path, "OPENCONTAINER", "TOFRONT"];
  const child = options.spawn(directoryOpusRuntime, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once?.("error", (error) => {
    options.logWarning?.(`Directory Opus reveal failed for ${path}`, error);
  });
  child.unref?.();
}

export function resolveDirectoryOpusRuntime(
  env: NodeJS.ProcessEnv,
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const root of new Set(roots)) {
    const candidate = win32.resolve(root, "GPSoftware", "Directory Opus", "dopusrt.exe");
    if (pathExists(candidate)) return candidate;
  }
  return null;
}
