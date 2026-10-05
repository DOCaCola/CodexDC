import { join } from "node:path";
import { readPlist } from "./plist.js";
import type { InstallerState } from "./state.js";

export function isNewerMacBuild(current: string, available: string): boolean {
  if (![current, available].every(value => /^\d+(?:\.\d+)*$/.test(value))) throw new Error("Invalid macOS app build number.");
  const left = current.split(".").map(BigInt), right = available.split(".").map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? 0n) - (left[i] ?? 0n);
    if (difference !== 0n) return difference > 0n;
  }
  return false;
}
export function macBuild(app: string): string {
  return String(readPlist(join(app, "Contents", "Info.plist")).CFBundleVersion);
}
export function selectMacSource(state: InstallerState, build = macBuild): string {
  if (!state.officialAppRoot) throw new Error("Official source is not recorded.");
  if (state.downloadedAppRoot && isNewerMacBuild(build(state.officialAppRoot), build(state.downloadedAppRoot))) return state.downloadedAppRoot;
  return state.officialAppRoot;
}
