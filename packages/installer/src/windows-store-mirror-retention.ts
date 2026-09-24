import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const STORE_APPS_DIR = "store-apps";
const MANAGED_ROOT_DIR = "codexdc";
const STORE_PACKAGE_VERSION = /_(\d+(?:\.\d+)+)_[^_]+__/i;

export interface WindowsStoreMirrorRetentionResult {
  storeRoot: string | null;
  retained: string[];
  removed: string[];
  failed: { path: string; error: unknown }[];
}

export interface WindowsStoreMirrorRemovalResult {
  packageRoot: string | null;
  removed: boolean;
  error: unknown | null;
}

/** Keep the active writable Store mirror and one prior package version. */
export function pruneWindowsStoreMirrors(
  activeAppRoot: string,
): WindowsStoreMirrorRetentionResult {
  const activePackageRoot = managedStorePackageRoot(activeAppRoot);
  if (!activePackageRoot) return emptyResult();

  const storeRoot = dirname(activePackageRoot);
  const activeKey = pathKey(activePackageRoot);
  let packageRoots: string[];
  try {
    packageRoots = readdirSync(storeRoot)
      .map((name) => join(storeRoot, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory() && parseStorePackageVersion(basename(path)) !== null;
        } catch {
          return false;
        }
      });
  } catch {
    return { ...emptyResult(), storeRoot };
  }

  const previous = packageRoots
    .filter((path) => pathKey(path) !== activeKey)
    .sort(compareStorePackageRoots)
    .at(0);
  const keep = new Set([activeKey, ...(previous ? [pathKey(previous)] : [])]);
  const retained = packageRoots.filter((path) => keep.has(pathKey(path)));
  const removed: string[] = [];
  const failed: { path: string; error: unknown }[] = [];

  for (const path of packageRoots) {
    if (keep.has(pathKey(path))) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (error) {
      failed.push({ path, error });
    }
  }

  return { storeRoot, retained, removed, failed };
}

/** Remove a failed writable Store mirror without touching non-managed paths. */
export function removeWindowsStoreMirror(
  appRoot: string,
): WindowsStoreMirrorRemovalResult {
  const packageRoot = managedStorePackageRoot(appRoot);
  if (!packageRoot) return { packageRoot: null, removed: false, error: null };

  try {
    rmSync(packageRoot, { recursive: true, force: true });
    return { packageRoot, removed: true, error: null };
  } catch (error) {
    return { packageRoot, removed: false, error };
  }
}

function managedStorePackageRoot(appRoot: string): string | null {
  const normalizedAppRoot = resolve(appRoot);
  const packageRoot = basename(normalizedAppRoot).toLowerCase() === "app"
    ? dirname(normalizedAppRoot)
    : normalizedAppRoot;
  const storeRoot = dirname(packageRoot);
  if (basename(storeRoot).toLowerCase() !== STORE_APPS_DIR) return null;
  if (basename(dirname(storeRoot)).toLowerCase() !== MANAGED_ROOT_DIR) return null;
  return packageRoot;
}

function compareStorePackageRoots(left: string, right: string): number {
  const leftVersion = parseStorePackageVersion(basename(left)) ?? [];
  const rightVersion = parseStorePackageVersion(basename(right)) ?? [];
  const length = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.localeCompare(left);
}

function parseStorePackageVersion(name: string): number[] | null {
  const match = STORE_PACKAGE_VERSION.exec(name);
  if (!match?.[1]) return null;
  return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

function pathKey(path: string): string {
  return resolve(path).replace(/\\/g, "/").toLowerCase();
}

function emptyResult(): WindowsStoreMirrorRetentionResult {
  return { storeRoot: null, retained: [], removed: [], failed: [] };
}
