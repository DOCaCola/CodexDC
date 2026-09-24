import { join } from "node:path";

export function windowsTaskbarIconPath(resourcesPath: string, systemDark: boolean): string {
  return join(resourcesPath, "codex-dc", systemDark ? "taskbar-dark.ico" : "taskbar-light.ico");
}

/** Native Windows properties are required by the desktop's Electron-compatible host. */
export function windowsTaskbarHelperArgs(script: string, icon: string, appId: string, processId: number, command: string, windowHandles: string[]): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-IconPath", icon, "-AppUserModelId", appId, "-OwnerProcessId", String(processId),
    "-WindowHandles", windowHandles.join(","),
    "-RelaunchCommandBase64", Buffer.from(command, "utf8").toString("base64")];
}
