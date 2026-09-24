import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureUserPaths } from "./paths.js";
import { findSourceRoot } from "./source-root.js";
import { readState, writeState } from "./state.js";
import { isCodexRunning } from "./alerts.js";
import { CODEXDC_VERSION, compareSemver } from "./version.js";
import { readSelfUpdateState, writeSelfUpdateState, type SelfUpdateState } from "./self-update-state.js";
import { downloadReleaseAsset, expectedChecksum, extractPackage, latestRelease, releaseAsset, verifyChecksum } from "./releases.js";

interface Opts { quiet?: boolean; onLaunch?: boolean; force?: boolean; repo?: string; ref?: string }

const updateServices = {
  latestRelease, downloadReleaseAsset,
  isCodexRunning,
  runCli: (node: string, args: string[], root: string, env: NodeJS.ProcessEnv) =>
    execFileSync(node, args, { cwd: root, env, timeout: 10 * 60_000, windowsHide: true }),
};
export class UpdateRecoveryError extends Error {}

export async function updatePackage(opts: Opts = {}): Promise<string | undefined> {
  const paths = ensureUserPaths();
  const root = findSourceRoot(dirname(fileURLToPath(import.meta.url)));
  return updatePackageFrom(root, paths, opts);
}

/** Package activation uses explicit paths so it is also usable from recovery tooling. */
export async function updatePackageFrom(
  root: string,
  paths: ReturnType<typeof ensureUserPaths>,
  opts: Opts = {},
  services = updateServices,
): Promise<string | undefined> {
  if ((opts.repo && opts.repo !== "DOCaCola/CodexDC") || opts.ref) throw new Error("Only published stable CodexDC release packages are supported.");
  if (existsSync(join(root, ".git"))) {
    if (!opts.quiet) console.log("Development checkout: update source with Git. Release updater is disabled.");
    return;
  }
  const config = existsSync(paths.configFile) ? JSON.parse(readFileSync(paths.configFile, "utf8")) : {};
  const lastCheck = readSelfUpdateState(paths.selfUpdateStateFile);
  if (opts.onLaunch && (config.codexPlusPlus?.autoUpdate === false ||
      (lastCheck && Date.now() - Date.parse(lastCheck.checkedAt) < 60 * 60_000))) return;
  const oldInstall = readState(paths.stateFile);
  if (oldInstall && services.isCodexRunning(oldInstall.appRoot)) {
    if (opts.onLaunch) return;
    throw new Error("Close CodexDC, then run Setup → Update CodexDC. Active sessions are never restarted.");
  }
  const diagnostic: SelfUpdateState = { checkedAt: new Date().toISOString(), status: "checking", currentVersion: CODEXDC_VERSION,
    latestVersion: null, targetRef: null, releaseUrl: null, repo: "DOCaCola/CodexDC", channel: "stable", sourceRoot: root };
  writeSelfUpdateState(paths.selfUpdateStateFile, diagnostic);
  const work = mkdtempSync(join(paths.root, ".update-"));
  try {
    const release = await services.latestRelease("DOCaCola/CodexDC");
    diagnostic.targetRef = release.tag_name;
    diagnostic.releaseUrl = release.html_url;
    diagnostic.latestVersion = release.tag_name.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(diagnostic.latestVersion)) throw new Error("Invalid stable release version");
    if (!opts.force && compareSemver(diagnostic.latestVersion, CODEXDC_VERSION) <= 0) {
      diagnostic.status = "up-to-date"; return;
    }
    const name = `CodexDC-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
    const asset = releaseAsset(release, name);
    const sum = expectedChecksum((await services.downloadReleaseAsset("DOCaCola/CodexDC", releaseAsset(release, "SHA256SUMS"))).toString(), name);
    const bytes = await services.downloadReleaseAsset("DOCaCola/CodexDC", asset);
    verifyChecksum(bytes, sum);
    const archive = join(work, name); writeFileSync(archive, bytes);
    const staged = join(work, "package"); await extractPackage(archive, staged);
    const manifest = JSON.parse(readFileSync(join(staged, "codexdc-release.json"), "utf8"));
    if (manifest.version !== diagnostic.latestVersion || manifest.target !== `${process.platform}-${process.arch}`) throw new Error("Release platform/version mismatch");
    const next = join(paths.root, "maintenance", `${release.id}-${sum.slice(0, 12)}`);
    mkdirSync(dirname(next), { recursive: true });
    if (!existsSync(next)) renameSync(staged, next);
    const node = join(next, "node", process.platform === "win32" ? "node.exe" : "node");
    const cli = join(next, "packages", "installer", "dist", "cli.js");
    // Candidate validation/repair must run the candidate even while the old
    // active-package selector still points to the previous version.
    const activationEnv = { ...process.env, CODEXDC_HOME: paths.root, CODEXDC_ACTIVATING: "1" };
    services.runCli(node, [cli, "--help"], next, activationEnv);
    if (oldInstall) {
      cpSync(paths.runtime, join(work, "old-runtime"), { recursive: true });
      try {
        services.runCli(node, [cli, "repair", "--force", "--quiet"], next, activationEnv);
      } catch (error) {
        rmSync(paths.runtime, { recursive: true, force: true });
        cpSync(join(work, "old-runtime"), paths.runtime, { recursive: true });
        writeState(paths.stateFile, oldInstall);
        try {
          services.runCli(process.execPath, [join(root, "packages", "installer", "dist", "cli.js"), "repair", "--force", "--quiet"], root, activationEnv);
        } catch (rollbackError) {
          throw new UpdateRecoveryError(`Activation failed and recovery needs attention. Previous package retained at ${root}. Run its Setup → Repair. Activation: ${String(error)} Recovery: ${String(rollbackError)}`);
        }
        throw new Error(`Release activation failed; previous installation restored. ${String(error)}`);
      }
    }
    const selectionTemp = join(paths.root, `maintenance-selection-${randomUUID()}.tmp`);
    writeFileSync(selectionTemp, JSON.stringify({ active: next, previous: root }));
    renameSync(selectionTemp, join(paths.root, "maintenance-selection.json"));
    diagnostic.sourceRoot = next; diagnostic.status = "updated";
    if (!opts.quiet) console.log(`Updated to ${manifest.version}. Previous package retained at ${root}`);
    return next;
  } catch (error) {
    diagnostic.status = "failed"; diagnostic.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    diagnostic.completedAt = new Date().toISOString();
    writeSelfUpdateState(paths.selfUpdateStateFile, diagnostic);
    rmSync(work, { recursive: true, force: true });
  }
}
