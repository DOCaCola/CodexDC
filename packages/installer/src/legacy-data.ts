import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { userPaths } from "./paths.js";

/** Copies user-owned data only. Old app state, runtimes and watchers are not imported. */
export function importLegacyData(source: string, destination = userPaths().root): void {
  if (existsSync(join(destination, "config.json")) || existsSync(join(destination, "tweaks"))) {
    throw new Error("CodexDC already has user data. Import into an empty data directory only.");
  }
  mkdirSync(destination, { recursive: true });
  for (const file of ["config.json", "tweak-data"]) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(destination, file), { recursive: true });
  }
  const tweaks = join(source, "tweaks");
  if (existsSync(tweaks)) {
    for (const entry of readdirSync(tweaks, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = join(tweaks, entry.name);
      const manifestFile = join(dir, "manifest.json");
      if (!existsSync(manifestFile)) continue;
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (manifest.id === "local.windows-store-update-bridge") continue;
      cpSync(dir, join(destination, "tweaks", entry.name), { recursive: true });
    }
  }
  // Preserve tweak flags, but do not inherit the old project's updater source.
  const configFile = join(destination, "config.json");
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.codexPlusPlus = { ...config.codexPlusPlus, updateRepo: "DOCaCola/CodexDC", updateChannel: "stable" };
    delete config.codexPlusPlus.updateRef;
    delete config.codexPlusPlus.updateCheck;
    writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
  writeFileSync(join(destination, "legacy-import.json"), JSON.stringify({ source, importedAt: new Date().toISOString() }));
}

export function legacyDataRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "codex-plusplus")
    : join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "codex-plusplus");
}
