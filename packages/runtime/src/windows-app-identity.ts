export const CODEX_PLUS_PLUS_WINDOWS_APP_USER_MODEL_ID = "DOCaCola.CodexDC";

export function inferWindowsAppUserModelId(resourcesPath: string | null | undefined): string | null {
  if (!resourcesPath) return null;

  const normalized = resourcesPath.replace(/\//g, "\\").replace(/\\+$/, "");
  const match = /(?:^|\\)([^\\]+)\\app\\resources$/i.exec(normalized);
  if (!match) return null;
  if (/\\codex-dc\\store-apps\\/i.test(normalized)) {
    return CODEX_PLUS_PLUS_WINDOWS_APP_USER_MODEL_ID;
  }

  const packageParts = /^(.+?)_\d+(?:\.\d+)+_[^_]+__([^_]+)$/i.exec(match[1]);
  if (!packageParts) return null;

  return `${packageParts[1]}_${packageParts[2]}!App`;
}
