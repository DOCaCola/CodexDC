import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export interface StorePackage {
  version: string;
  installLocation: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const storeUpdateScript = resolve(
  here,
  "..",
  "assets",
  "bundled-tweaks",
  "windows-store-update-bridge",
  "store-update.ps1",
);
const STORE_UPDATE_TIMEOUT_MS = 15 * 60_000;
const STORE_UPDATE_POLL_MS = 2_000;

export function compareStoreVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function packageNameFromFamily(family: string): string {
  const match = /^([A-Za-z0-9_.-]+)_[A-Za-z0-9]+$/.exec(family);
  if (!match) throw new Error(`Invalid Windows Store package family: ${family}`);
  return match[1];
}

export function queryInstalledStorePackage(family: string): StorePackage | null {
  const packageName = packageNameFromFamily(family);
  const command = [
    `$pkg = Get-AppxPackage -Name '${packageName}'`,
    `| Where-Object PackageFamilyName -eq '${family}'`,
    "| Sort-Object Version -Descending",
    "| Select-Object -First 1 Version,InstallLocation;",
    "if ($pkg) { $pkg | ConvertTo-Json -Compress }",
  ].join(" ");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  ).trim();
  if (!output) return null;
  const parsed = JSON.parse(output) as { Version?: unknown; InstallLocation?: unknown };
  const version = String(parsed.Version ?? "").trim();
  const installLocation = String(parsed.InstallLocation ?? "").trim();
  return version && installLocation ? { version, installLocation } : null;
}

export function startStoreUpdate(family: string): boolean {
  packageNameFromFamily(family);
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      storeUpdateScript,
      "start",
      family,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  const result = JSON.parse(output) as { queued?: unknown };
  return result.queued === true;
}

export function isStorePackageReady(
  installed: StorePackage | null,
  previousVersion: string,
  fileExists: (path: string) => boolean = existsSync,
): installed is StorePackage {
  if (!installed || compareStoreVersions(installed.version, previousVersion) <= 0) return false;
  return (
    fileExists(join(installed.installLocation, "app", "resources", "app.asar")) ||
    fileExists(join(installed.installLocation, "resources", "app.asar"))
  );
}

export async function waitForNewStorePackage(
  family: string,
  previousVersion: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    query?: (family: string) => StorePackage | null;
    fileExists?: (path: string) => boolean;
    pause?: (ms: number) => Promise<unknown>;
    onProgress?: (message: string) => void;
    progressIntervalMs?: number;
  } = {},
): Promise<StorePackage> {
  const query = options.query ?? queryInstalledStorePackage;
  const fileExists = options.fileExists ?? existsSync;
  const pause = options.pause ?? delay;
  const timeoutMs = options.timeoutMs ?? STORE_UPDATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? STORE_UPDATE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let lastObservedVersion: string | null = null;
  while (Date.now() < deadline) {
    const installed = query(family);
    const observedVersion = installed?.version ?? "not registered";
    const newerVersion = installed
      ? compareStoreVersions(installed.version, previousVersion) > 0
      : false;
    if (isStorePackageReady(installed, previousVersion, fileExists)) return installed;
    const now = Date.now();
    if (
      options.onProgress &&
      (observedVersion !== lastObservedVersion ||
        now - lastProgressAt >= (options.progressIntervalMs ?? 15_000))
    ) {
      const elapsed = Math.floor((now - startedAt) / 1_000);
      options.onProgress(
        newerVersion
          ? `Windows Store registered ${observedVersion}; waiting for app files (${elapsed}s)`
          : `Waiting for a newer Windows Store package; installed version: ${observedVersion} (${elapsed}s)`,
      );
      lastObservedVersion = observedVersion;
      lastProgressAt = now;
    }
    await pause(pollMs);
  }
  throw new Error(`Timed out waiting for Windows Store to install ${family} after ${previousVersion}`);
}

export async function installNewStorePackage(
  family: string,
  previousVersion: string,
  onProgress?: (message: string) => void,
): Promise<StorePackage> {
  packageNameFromFamily(family);
  if (!/^\d+(?:\.\d+)+$/.test(previousVersion)) {
    throw new Error(`Invalid previous Windows Store version: ${previousVersion}`);
  }
  const current = queryInstalledStorePackage(family);
  const currentVersion = current?.version ?? "not registered";
  if (isStorePackageReady(current, previousVersion)) {
    onProgress?.(`Newer Windows Store package ${current.version} is already installed`);
    return current;
  }
  onProgress?.(`Installed Windows Store version: ${currentVersion}; submitting update request`);
  if (!startStoreUpdate(family)) {
    const installed = queryInstalledStorePackage(family);
    if (isStorePackageReady(installed, previousVersion)) {
      onProgress?.(`Newer Windows Store package ${installed.version} became available during the update request`);
      return installed;
    }
    throw new Error(`Windows Store did not queue an update for ${family}`);
  }
  onProgress?.("Windows Store accepted the update request");
  return waitForNewStorePackage(family, previousVersion, { onProgress });
}
