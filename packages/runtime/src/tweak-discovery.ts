/**
 * Discover tweaks under <userRoot>/tweaks. Each tweak is a directory with a
 * manifest.json and an entry script. Entry resolution is manifest.main first,
 * then index.js, index.mjs, and index.cjs.
 *
 * The manifest gate is intentionally strict about shape, but local tweaks may
 * omit `githubRepo`. If present, CodexDC can surface advisory GitHub release
 * checks without granting the tweak an automatic update/install channel.
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TweakManifest } from "@codexdc/sdk";

export interface DiscoveredTweak {
  dir: string;
  entry: string;
  manifest: TweakManifest;
}

const ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"];

export function discoverTweaks(tweaksDir: string): DiscoveredTweak[] {
  if (!existsSync(tweaksDir)) return [];
  const out: DiscoveredTweak[] = [];
  for (const name of readdirSync(tweaksDir)) {
    const dir = join(tweaksDir, name);
    if (!existsSync(dir)) continue;
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: TweakManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TweakManifest;
    } catch {
      continue;
    }
    if (!isValidManifest(manifest)) continue;
    const entry = resolveEntry(dir, manifest);
    if (!entry) continue;
    out.push({ dir, entry, manifest });
  }
  return out;
}

function isValidManifest(m: TweakManifest): boolean {
  if (!m.id || !m.name || !m.version) return false;
  if (m.githubRepo && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(m.githubRepo)) return false;
  if (m.scope && !["renderer", "main", "both"].includes(m.scope)) return false;
  return true;
}

function resolveEntry(dir: string, m: TweakManifest): string | null {
  if (m.main) {
    const p = join(dir, m.main);
    return existsSync(p) ? p : null;
  }
  for (const c of ENTRY_CANDIDATES) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  return null;
}
