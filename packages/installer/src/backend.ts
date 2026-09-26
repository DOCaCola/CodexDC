import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { userPaths } from "./paths.js";
import { CODEXDC_VERSION } from "./version.js";
import { downloadReleaseAsset, expectedChecksum, extractPackage, latestRelease, releaseAsset, verifyChecksum, type Release } from "./releases.js";

export const CLI_REPO = "DOCaCola/codex";
export interface BackendPackage { tag: string; releaseId: number; version: string; executable: string; digest: string }
export interface BackendState {
  provider: "bundled" | "fork" | "development";
  autoUpdate?: boolean;
  updateCheck?: { checkedAt: string; error?: string };
  installed?: BackendPackage;
  previous?: BackendPackage;
  development?: { executable: string; version: string };
}

export function backendState(root = userPaths().root): BackendState {
  const file = join(root, "backend.json");
  if (!existsSync(file)) return { provider: "fork" };
  const state = JSON.parse(readFileSync(file, "utf8")) as BackendState;
  if (!["bundled", "fork", "development"].includes(state.provider)) throw new Error("Invalid CLI backend selection");
  return state;
}

function save(state: BackendState, root: string): void {
  mkdirSync(root, { recursive: true });
  const temp = join(root, `backend-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, join(root, "backend.json"));
}

export function setBackendAutoUpdate(enabled: boolean, root = userPaths().root): BackendState {
  const state = backendState(root);
  save({ ...state, autoUpdate: enabled, updateCheck: undefined }, root);
  return backendState(root);
}

export function backendEnvironment(state: BackendState, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.CODEX_CLI_PATH;
  if (state.provider === "fork") {
    if (!state.installed || !existsSync(state.installed.executable)) {
      throw new Error("The selected DC fork CLI is missing. Reinstall it or explicitly select the desktop-bundled CLI.");
    }
    env.CODEX_CLI_PATH = state.installed.executable;
  }
  if (state.provider === "development") {
    if (!state.development || !existsSync(state.development.executable)) {
      throw new Error("The local CLI is missing. Rebuild it or select another CLI backend.");
    }
    env.CODEX_CLI_PATH = state.development.executable;
  }
  return env;
}

export function selectBackend(provider: string, root = userPaths().root): BackendState {
  if (provider !== "bundled" && provider !== "fork" && provider !== "development") throw new Error("CLI provider must be bundled, fork or development");
  const state = backendState(root);
  backendEnvironment({ ...state, provider }, {});
  save({ ...state, provider }, root);
  return backendState(root);
}

/** Prepare the saved choice, importing an explicit local override on first setup. */
export async function prepareBackend(
  root = userPaths().root,
  inherited: NodeJS.ProcessEnv = process.env,
  install = installBackend,
  probe = probeBackend,
): Promise<BackendState> {
  if (!existsSync(join(root, "backend.json")) && inherited.CODEX_CLI_PATH) {
    return configureDevelopmentBackend(inherited.CODEX_CLI_PATH, root, probe);
  }
  let state = backendState(root);
  if (state.provider === "fork" && !state.installed) state = await install(root);
  backendEnvironment(state, {});
  return state;
}

/** Selecting the fork installs its complete package if it is not available yet. */
export async function selectAvailableBackend(
  provider: string,
  root = userPaths().root,
  install = installBackend,
): Promise<BackendState> {
  if (provider === "fork") {
    const state = backendState(root);
    if (!state.installed || !existsSync(state.installed.executable)) await install(root);
  }
  return selectBackend(provider, root);
}

export async function configureDevelopmentBackend(
  executable: string,
  root = userPaths().root,
  probe = probeBackend,
): Promise<BackendState> {
  if (!executable.trim()) throw new Error("Specify the local CLI executable path.");
  const path = resolve(executable);
  const version = await probe(path);
  save({ ...backendState(root), provider: "development", development: { executable: path, version } }, root);
  return backendState(root);
}

export function rollbackBackend(root = userPaths().root): BackendState {
  const state = backendState(root);
  if (!state.previous || !existsSync(state.previous.executable)) throw new Error("No previous DC fork package is available");
  save({ ...state, installed: state.previous, previous: state.installed, autoUpdate: false }, root);
  return backendState(root);
}

export function backendAssetName(platform: string, arch: string): string {
  if (platform === "win32" && arch === "x64") return "codex-doca-x86_64-pc-windows-msvc.zip";
  if (platform === "darwin" && arch === "arm64") return "codex-doca-aarch64-apple-darwin.tar.gz";
  throw new Error(`No DC fork CLI package is configured for ${platform}/${arch}`);
}

export async function checkBackend(): Promise<{ tag: string; url: string; asset: string }> {
  const release = await latestRelease(CLI_REPO);
  const asset = releaseAsset(release, backendAssetName(process.platform, process.arch));
  return { tag: release.tag_name, url: release.html_url, asset: asset.name };
}

export function validateBackendPackage(root: string, platform = process.platform): string {
  const manifest = JSON.parse(readFileSync(join(root, "codex-package.json"), "utf8"));
  const target = platform === "win32" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin";
  const extension = platform === "win32" ? ".exe" : "";
  const entrypoint = `bin/codex${extension}`;
  if (manifest.layoutVersion !== 1 || manifest.target !== target || manifest.entrypoint !== entrypoint ||
      manifest.resourcesDir !== "codex-resources" || manifest.pathDir !== "codex-path") {
    throw new Error("Unsupported CLI package layout or target");
  }
  const required = [entrypoint, `bin/hpatch${extension}`, `bin/codex-code-mode-host${extension}`, `codex-path/rg${extension}`];
  if (platform === "win32") required.push("codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe");
  for (const file of required) {
    if (!existsSync(join(root, file))) throw new Error(`Incomplete CLI package: missing ${file}`);
  }
  return join(root, entrypoint);
}

/** Checks app-server startup in a disposable home; never starts a user task. */
export async function probeBackend(executable: string): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "codexdc-cli-probe-"));
  const env = { ...process.env, CODEX_HOME: home };
  try {
    const version = execFileSync(executable, ["--version"], { env, encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["app-server"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let outcome: Error | null = null;
      let initialized = false;
      const timer = setTimeout(() => { outcome = new Error("CLI app-server initialization timed out"); child.kill(); }, 20_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        let end: number;
        while ((end = output.indexOf("\n")) >= 0) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.id !== 1) continue;
            if (message.error || !message.result?.userAgent) outcome = new Error("CLI app-server rejected initialization");
            else initialized = true;
            child.kill();
          } catch { /* Ignore non-protocol diagnostic lines. */ }
        }
      });
      child.on("close", () => {
        clearTimeout(timer);
        if (outcome) reject(outcome);
        else if (!initialized) reject(new Error("CLI app-server exited before initialization"));
        else resolve();
      });
      child.stdin.on("error", () => {});
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "codexdc", title: "CodexDC compatibility check", version: CODEXDC_VERSION },
        capabilities: { experimentalApi: true },
      } }) + "\n");
    });
    return version;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const installServices = { latestRelease, downloadReleaseAsset, probeBackend, platform: process.platform, arch: process.arch };

export async function installBackend(root = userPaths().root, candidate?: Release, services = installServices): Promise<BackendState> {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, "backend-install.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx"); } catch { throw new Error("Another CLI installation is active. Retry when it finishes."); }
  const work = join(root, "cli", `.staging-${randomUUID()}`);
  try {
    const release: Release = candidate ?? await services.latestRelease(CLI_REPO);
    const asset = releaseAsset(release, backendAssetName(services.platform, services.arch));
    const sums = await services.downloadReleaseAsset(CLI_REPO, releaseAsset(release, "SHA256SUMS"));
    const digest = expectedChecksum(sums.toString("utf8"), asset.name);
    const bytes = await services.downloadReleaseAsset(CLI_REPO, asset);
    verifyChecksum(bytes, digest);
    mkdirSync(work, { recursive: true });
    const archive = join(work, asset.name);
    writeFileSync(archive, bytes);
    const unpacked = join(work, "package");
    await extractPackage(archive, unpacked);
    const relativeExe = join("bin", services.platform === "win32" ? "codex.exe" : "codex");
    const version = await services.probeBackend(validateBackendPackage(unpacked, services.platform));
    const destination = join(root, "cli", `${release.id}-${services.platform}-${services.arch}-${digest.slice(0, 12)}`);
    if (!existsSync(destination)) renameSync(unpacked, destination);
    const state = backendState(root);
    const installed = { tag: release.tag_name, releaseId: release.id, version, executable: join(destination, relativeExe), digest };
    save({ ...state, installed, previous: state.installed?.executable === installed.executable ? state.previous : state.installed }, root);
    return backendState(root);
  } finally {
    rmSync(work, { recursive: true, force: true });
    closeSync(lock); rmSync(lockPath, { force: true });
  }
}
