import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredTweak } from "./tweak-discovery";
import { STORE_INSTALL_METADATA_FILE } from "./tweak-install-source";
import { normalizeGitHubRepo, type TweakStoreEntry } from "./tweak-store";

export interface ReplacementState {
  tweaks?: Record<string, { enabled?: boolean }>;
  tweakUpdateChecks?: Record<string, unknown>;
}

/**
 * Store installs of the tweaks a Store entry declares in `replaces`. Only
 * installs from the entry's own repository qualify, so a Store tweak cannot
 * take over a tweak published elsewhere.
 */
export function replacedStoreTweaks(
  entry: Pick<TweakStoreEntry, "repo" | "manifest">,
  discovered: readonly DiscoveredTweak[],
): DiscoveredTweak[] {
  const ids = new Set(entry.manifest.replaces ?? []);
  return discovered.filter((tweak) => ids.has(tweak.manifest.id) && storeInstallRepo(tweak.dir) === entry.repo);
}

function storeInstallRepo(dir: string): string | null {
  const metadata = join(dir, STORE_INSTALL_METADATA_FILE);
  if (!existsSync(metadata)) return null;
  return normalizeGitHubRepo(String((JSON.parse(readFileSync(metadata, "utf8")) as { repo?: unknown }).repo));
}

/**
 * Hand replaced tweaks' enabled state and data over to their successor and
 * remove the replaced installs. Settings the successor already has win.
 * Main-process tweaks must be stopped before calling this.
 */
export function retireReplacedTweaks(
  successorId: string,
  replaced: readonly DiscoveredTweak[],
  dataRoot: string,
  state: ReplacementState,
): void {
  const successorData = join(dataRoot, successorId);
  for (const tweak of replaced) {
    const id = tweak.manifest.id;
    const toggle = state.tweaks?.[id];
    if (toggle) {
      state.tweaks![successorId] ??= toggle;
      delete state.tweaks![id];
    }
    delete state.tweakUpdateChecks?.[id];
    const data = join(dataRoot, id);
    if (existsSync(data)) {
      if (existsSync(successorData)) rmSync(data, { recursive: true, force: true });
      else renameSync(data, successorData);
    }
    rmSync(tweak.dir, { recursive: true, force: true });
  }
}
