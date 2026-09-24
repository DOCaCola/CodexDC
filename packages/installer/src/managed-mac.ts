import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeaderHash } from "./asar.js";
import { isCodexRunning } from "./alerts.js";
import { prepareCodeSigning, signCodexApp, signatureInfo, verifySignature } from "./codesign.js";
import { install } from "./commands/install.js";
import { locateCodex } from "./platform.js";
import { readPlist, writePlist } from "./plist.js";
import { ensureUserPaths } from "./paths.js";
import { readState, writeState } from "./state.js";
import { installWatcher, uninstallWatcher } from "./watcher.js";

export const MANAGED_MAC_ID = "io.github.docacola.codexdc";
const assets = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets");

export async function installManagedMac(opts: { app?: string; force?: boolean; quiet?: boolean } = {}): Promise<void> {
  const paths = ensureUserPaths();
  const previous = readState(paths.stateFile);
  const source = locateCodex(opts.app ?? previous?.officialAppRoot);
  if (source.bundleId === MANAGED_MAC_ID || source.appRoot === previous?.appRoot) {
    throw new Error("Select the official Codex installation as the source.");
  }
  const signature = signatureInfo(source.appRoot);
  if (!signature?.teamIdentifier || !verifySignature(source.appRoot).ok) throw new Error("The official source must have a valid publisher signature.");
  const sourceHash = readHeaderHash(source.asarPath).headerHash;
  if (!opts.force && previous?.sourceRoot === resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..") &&
      previous?.sourceAsarHash === sourceHash && existsSync(previous.appRoot) &&
      readHeaderHash(join(previous.appRoot, "Contents", "Resources", "app.asar")).headerHash === previous.patchedAsarHash) return;
  const destination = previous?.managedCopy ? previous.appRoot : join(homedir(), "Applications", "CodexDC.app");
  if (existsSync(destination) && !previous?.managedCopy) throw new Error(`${destination} already exists and is not owned by CodexDC.`);
  if (existsSync(destination) && isCodexRunning(destination)) throw new Error("Close CodexDC before refreshing its managed copy.");
  const launcher = join(assets, "mac-launcher");
  if (!existsSync(launcher)) throw new Error("The macOS release is missing its native launcher.");
  const identity = prepareCodeSigning({ useLocalIdentity: true, identityName: "CodexDC Local Signing" });
  const lockPath = join(paths.root, "managed-install.lock");
  const lock = openSync(lockPath, "wx");
  const stage = join(dirname(destination), `.CodexDC-${randomUUID()}.app`);
  const backup = `${destination}.previous`;
  mkdirSync(dirname(destination), { recursive: true });
  const oldState = existsSync(paths.stateFile) ? readFileSync(paths.stateFile) : null;
  const recovery = mkdtempSync(join(paths.root, ".mac-recovery-"));
  cpSync(paths.runtime, join(recovery, "runtime"), { recursive: true });
  cpSync(paths.binDir, join(recovery, "bin"), { recursive: true });
  let activated = false;
  try {
    execFileSync("ditto", [source.appRoot, stage]);
    if (!verifySignature(stage).ok || readHeaderHash(join(stage, "Contents", "Resources", "app.asar")).headerHash !== sourceHash) {
      throw new Error("Official app changed while being copied. Retry after its update finishes.");
    }
    const infoPath = join(stage, "Contents", "Info.plist");
    const info = readPlist(infoPath);
    const executable = String(info.CFBundleExecutable);
    const original = `${executable}-original`;
    renameSync(join(stage, "Contents", "MacOS", executable), join(stage, "Contents", "MacOS", original));
    cpSync(launcher, join(stage, "Contents", "MacOS", executable));
    info.CFBundleIdentifier = MANAGED_MAC_ID;
    info.CFBundleName = "CodexDC";
    info.CFBundleDisplayName = "CodexDC";
    info.SUEnableAutomaticChecks = false;
    info.SUAllowsAutomaticUpdates = false;
    writePlist(infoPath, info);
    writeFileSync(join(stage, "Contents", "Resources", "codexdc-launch.json"), JSON.stringify({
      backendFile: join(paths.root, "backend.json"), originalExecutable: original,
    }));
    await install({ app: stage, resign: false, watcher: false, quiet: opts.quiet });
    signCodexApp(stage, { useLocalIdentity: true, preparedIdentity: identity });
    if (!verifySignature(stage).ok) throw new Error("Managed app signature verification failed");
    const stagedState = readState(paths.stateFile)!;
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(destination)) renameSync(destination, backup);
    try { renameSync(stage, destination); } catch (error) {
      if (existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    activated = true;
    writeState(paths.stateFile, { ...stagedState, appRoot: destination, officialAppRoot: source.appRoot,
      sourceAsarHash: sourceHash, managedCopy: true, resigned: true, signingMode: "local-identity",
      signingIdentity: identity!.name, signingIdentityHash: identity!.hash, nodePath: process.execPath,
      codexChannel: source.channel, watcher: "launchd" });
    installWatcher(source.appRoot);
    console.log(`CodexDC installed at ${destination}`);
  } catch (error) {
    if (activated) {
      rmSync(destination, { recursive: true, force: true });
      if (existsSync(backup)) renameSync(backup, destination);
    }
    rmSync(paths.runtime, { recursive: true, force: true });
    cpSync(join(recovery, "runtime"), paths.runtime, { recursive: true });
    rmSync(paths.binDir, { recursive: true, force: true });
    cpSync(join(recovery, "bin"), paths.binDir, { recursive: true });
    if (oldState) writeFileSync(paths.stateFile, oldState);
    else rmSync(paths.stateFile, { force: true });
    if (activated) {
      uninstallWatcher();
      if (previous?.officialAppRoot && previous.watcher !== "none") installWatcher(previous.officialAppRoot);
    }
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(recovery, { recursive: true, force: true });
    closeSync(lock); rmSync(lockPath, { force: true });
  }
}

export function uninstallManagedMac(): void {
  const paths = ensureUserPaths();
  const state = readState(paths.stateFile);
  if (!state?.managedCopy || state.appRoot === state.officialAppRoot) throw new Error("No managed CodexDC app is recorded.");
  if (isCodexRunning(state.appRoot)) throw new Error("Close CodexDC before uninstalling.");
  if (existsSync(state.appRoot) && readPlist(join(state.appRoot, "Contents", "Info.plist")).CFBundleIdentifier !== MANAGED_MAC_ID) {
    throw new Error("Recorded app is not CodexDC; refusing to remove it.");
  }
  uninstallWatcher();
  rmSync(state.appRoot, { recursive: true, force: true });
  rmSync(`${state.appRoot}.previous`, { recursive: true, force: true });
  rmSync(paths.runtime, { recursive: true, force: true });
  rmSync(paths.stateFile, { force: true });
  console.log("CodexDC removed. Official Codex and user settings remain.");
}
