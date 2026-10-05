import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { InstallerState } from "./state.js";
import { readState, writeState } from "./state.js";
import { readPlist } from "./plist.js";
import { readHeaderHash } from "./asar.js";
import { getIntegrity } from "./integrity.js";
import { locateCodex } from "./platform.js";
import { verifySignature } from "./codesign.js";
import { ensureUserPaths } from "./paths.js";
import { selectMacSource } from "./mac-source.js";

const WORKING_STATE = "mac-working-state.json";
export function isConfirmedMacInstall(root: string, state: InstallerState): boolean {
  const working = readState(join(root, WORKING_STATE));
  return working?.installedAt === state.installedAt && working.patchedAsarHash === state.patchedAsarHash;
}

/** Repairs of the same desktop build and failed startups must not replace recovery. */
export function shouldRotateMacBackup(confirmed: boolean, currentBuild: string, nextBuild: string, hasBackup: boolean): boolean {
  return confirmed && (!hasBackup || currentBuild !== nextBuild);
}

function releaseDirectory(cache: string, app: string): string {
  const normalized = resolve(app);
  const release = dirname(dirname(normalized));
  if (dirname(release) !== resolve(cache) || !/^release-[A-Za-z0-9]+$/.test(basename(release)) ||
      dirname(normalized) !== join(release, "extracted") || !normalized.endsWith(".app") || lstatSync(release).isSymbolicLink()) {
    throw new Error(`Desktop release reference is outside the managed cache: ${app}`);
  }
  return release;
}

/** Only known generated release directories are eligible; unknown files stay put. */
export function pruneMacDesktopReleases(root: string, references: string[]): { retained: string[]; removed: string[] } {
  const cache = join(root, "desktop-releases");
  if (!existsSync(cache)) return { retained: [], removed: [] };
  const keep = new Set(references.map(app => releaseDirectory(cache, app)));
  const retained: string[] = [], removed: string[] = [];
  for (const name of readdirSync(cache)) {
    if (!/^release-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = join(cache, name);
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) continue;
    if (keep.has(directory)) retained.push(directory);
    else { rmSync(directory, { recursive: true }); removed.push(directory); }
  }
  return { retained, removed };
}

/** A desktop reports successful startup only after a window has loaded. */
export function confirmMacDesktopStartup(installedAt: string) {
  const paths = ensureUserPaths();
  // Hold the update lock, rather than only checking it, so downloads cannot
  // begin between checking references and deleting unreferenced directories.
  const updateLockPath = join(paths.root, "mac-update.lock");
  const updateLock = openSync(updateLockPath, "wx");
  try {
    const lockPath = join(paths.root, "managed-install.lock");
    const lock = openSync(lockPath, "wx");
    try {
      const state = readState(paths.stateFile);
      if (!state?.managedCopy || state.installedAt !== installedAt) throw new Error("Startup confirmation does not match the installed desktop.");
      const install = locateCodex(state.appRoot);
      if (install.bundleId !== "io.github.docacola.codexdc" ||
          readHeaderHash(install.asarPath).headerHash !== state.patchedAsarHash ||
          getIntegrity(install)?.hash !== state.patchedAsarHash || !verifySignature(state.appRoot).ok) {
        throw new Error("Cannot confirm a desktop with invalid identity, integrity or signature.");
      }
      // The official copy can replace a redundant downloaded repair source.
      if (state.downloadedAppRoot && selectMacSource(state) === state.officialAppRoot &&
          readHeaderHash(join(state.officialAppRoot!, "Contents/Resources/app.asar")).headerHash === state.sourceAsarHash) {
        delete state.downloadedAppRoot;
        writeState(paths.stateFile, state);
      }
      writeState(join(paths.root, WORKING_STATE), state);
      const references = state.downloadedAppRoot ? [state.downloadedAppRoot] : [];
      const preparedFile = join(paths.root, "prepared-mac-update.json");
      if (existsSync(preparedFile)) {
        const prepared = JSON.parse(readFileSync(preparedFile, "utf8")) as { app: string; build: string };
        const currentBuild = String(readPlist(install.metaPath!).CFBundleVersion);
        if (prepared.build === currentBuild) rmSync(preparedFile);
        else references.push(prepared.app);
      }
      return pruneMacDesktopReleases(paths.root, references);
    } finally {
      closeSync(lock); rmSync(lockPath);
    }
  } finally { closeSync(updateLock); rmSync(updateLockPath); }
}

/** Commit a single rollback snapshot after the replacement app was installed. */
export function replaceMacRollback(app: string, displaced: string, snapshot: string, root: string): void {
  const backup = `${app}.previous`, metadata = join(root, "desktop-rollback");
  const retiredApp = `${displaced}.retired`, retiredMetadata = `${snapshot}.retired`;
  let appMoved = false, metadataMoved = false;
  try {
    if (existsSync(backup)) renameSync(backup, retiredApp);
    if (existsSync(metadata)) renameSync(metadata, retiredMetadata);
    renameSync(displaced, backup); appMoved = true;
    renameSync(snapshot, metadata); metadataMoved = true;
  } catch (error) {
    if (metadataMoved) renameSync(metadata, snapshot);
    if (appMoved) renameSync(backup, displaced);
    if (existsSync(retiredApp)) renameSync(retiredApp, backup);
    if (existsSync(retiredMetadata)) renameSync(retiredMetadata, metadata);
    throw error;
  }
  rmSync(retiredApp, { recursive: true, force: true });
  rmSync(retiredMetadata, { recursive: true, force: true });
}
