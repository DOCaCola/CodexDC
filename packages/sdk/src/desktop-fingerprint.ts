import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const desktopStartupFiles = ["main.js", "desktop-bootstrap.js", "native/codexdc_windows_restart.node"];

/** Identify all loaded startup code, including the Windows native policy. */
export function desktopFingerprint(runtime: string, loader: Uint8Array): string {
  const hash = createHash("sha256").update(loader);
  for (const file of desktopStartupFiles) hash.update(readFileSync(join(runtime, file)));
  return hash.digest("hex");
}
