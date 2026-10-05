import { execFileSync } from "node:child_process";
import { extractFile } from "@electron/asar";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneMacDesktopReleases } from "./mac-desktop-retention.js";
import { latestMacRelease } from "./mac-appcast.js";
import { downloadMacRelease } from "./mac-download.js";
import { isNewerMacBuild, selectMacSource } from "./mac-source.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import { readPlist } from "./plist.js";
import { readState } from "./state.js";
import { ensureUserPaths } from "./paths.js";
import { installManagedMac } from "./managed-mac.js";
import { parseProcessId, waitForProcessExit } from "./commands/repair-after-exit.js";
import { launchMacDesktop } from "./mac-desktop-launch.js";
import { backendEnvironment, backendState } from "./backend.js";
export { isNewerMacBuild } from "./mac-source.js";

export function checkMacUpdate() {
  const state = readState(ensureUserPaths().stateFile);
  if (!state?.managedCopy || !state.officialAppRoot) throw new Error("Install a managed CodexDC app first.");
  const source = selectMacSource(state);
  const official = readPlist(join(source, "Contents", "Info.plist"));
  const managed = readPlist(join(state.appRoot, "Contents", "Info.plist"));
  if (official.CFBundleIdentifier !== "com.openai.codex" || managed.CFBundleIdentifier !== "io.github.docacola.codexdc") throw new Error("Update source or managed app identity does not match.");
  const current = String(managed.CFBundleVersion), available = String(official.CFBundleVersion);
  return { ready: isNewerMacBuild(current, available), current, available };
}
function publisherMetadata() {
  const state = readState(ensureUserPaths().stateFile)!;
  const source = selectMacSource(state);
  return { source, metadata: JSON.parse(extractFile(join(source, "Contents/Resources/app.asar"), "package.json").toString()) };
}
export async function checkOnlineMacUpdate() {
  const local = checkMacUpdate();
  if (local.ready) return { ...local, online: null };
  const { metadata } = publisherMetadata();
  const feed = new URL(metadata.codexSparkleFeedUrl);
  if (feed.protocol !== "https:") throw new Error("Update feed must use HTTPS.");
  const response = await fetch(feed, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}.`);
  const osVersion = execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  const latest = latestMacRelease(await response.text(), process.arch, osVersion);
  return { ...local, online: latest && isNewerMacBuild(local.current, latest.build) ? latest : null };
}
export async function prepareMacUpdate(): Promise<string | undefined> {
  const update = await checkOnlineMacUpdate();
  if (update.ready) return undefined;
  if (!update.online) throw new Error("No newer compatible release is available.");
  const { source, metadata } = publisherMetadata();
  const team = signatureInfo(source)?.teamIdentifier;
  if (!team || !verifySignature(source).ok) throw new Error("Cannot establish the publisher's update key from an invalid source.");
  const paths = ensureUserPaths();
  const preparedFile = join(paths.root, "prepared-mac-update.json");
  if (existsSync(preparedFile)) {
    const prepared = JSON.parse(readFileSync(preparedFile, "utf8"));
    if (prepared.build === update.online.build && existsSync(prepared.app)) {
      const info = readPlist(join(prepared.app, "Contents", "Info.plist"));
      if (info.CFBundleIdentifier !== "com.openai.codex" || String(info.CFBundleVersion) !== update.online.build ||
          signatureInfo(prepared.app)?.teamIdentifier !== team || !verifySignature(prepared.app).ok) {
        throw new Error("Prepared update no longer has a valid publisher identity.");
      }
      return prepared.app as string;
    }
  }
  const app = await downloadMacRelease(update.online, metadata.codexSparklePublicKey, team,
    join(paths.root, "desktop-releases"), percent => process.send?.({ type: "progress", percent }));
  writeFileSync(preparedFile, JSON.stringify({ app, build: update.online.build }));
  const state = readState(paths.stateFile)!;
  pruneMacDesktopReleases(paths.root, [...(state.downloadedAppRoot ? [state.downloadedAppRoot] : []), app]);
  return app;
}
export async function applyMacUpdate(pid: number, services = {
  prepare: prepareMacUpdate,
  ready: () => { if (!process.send) throw new Error("Update helper requires an IPC parent."); process.send({ type: "ready" }); process.disconnect(); },
  wait: waitForProcessExit,
  repair: (downloadedSource: string | undefined) => installManagedMac({ force: true, quiet: true, downloadedSource }),
  status: (error: string | null) => writeFileSync(join(ensureUserPaths().root, "mac-update-result.json"), JSON.stringify({ error })),
  launch: () => {
    const state = readState(ensureUserPaths().stateFile)!;
    launchMacDesktop(state.appRoot, [], backendEnvironment(backendState(), process.env));
  },
}) {
  const source = await services.prepare();
  services.ready();
  await services.wait(pid);
  try {
    await services.repair(source);
    services.status(null);
  } catch (error) {
    services.status(error instanceof Error ? error.message : String(error));
    services.launch();
    throw error;
  }
  services.launch();
}
export async function macUpdate(opts: { pid?: string } = {}) {
  if (process.platform !== "darwin") throw new Error("mac-update requires macOS.");
  if (opts.pid === undefined) console.log(JSON.stringify(await checkOnlineMacUpdate()));
  else {
    const lockPath = join(ensureUserPaths().root, "mac-update.lock");
    const lock = openSync(lockPath, "wx");
    try { await applyMacUpdate(parseProcessId(opts.pid)); }
    catch (error) {
      if (process.connected) process.send?.({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { closeSync(lock); rmSync(lockPath); }
  }
}
