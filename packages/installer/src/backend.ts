import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { userPaths } from "./paths.js";
import { downloadReleaseAsset, expectedChecksum, extractPackage, latestRelease, releaseAsset, verifyChecksum, type Release } from "./releases.js";

export const CLI_REPO = "DOCaCola/codex";
export interface BackendPackage { tag: string; releaseId: number; version: string; executable: string; digest: string }
export interface BackendState { provider: "bundled" | "fork"; installed?: BackendPackage; previous?: BackendPackage }

export function backendState(root = userPaths().root): BackendState {
  const file = join(root, "backend.json");
  if (!existsSync(file)) return { provider: "bundled" };
  const state = JSON.parse(readFileSync(file, "utf8")) as BackendState;
  if (!["bundled", "fork"].includes(state.provider)) throw new Error("Invalid CLI backend selection");
  return state;
}

function save(state: BackendState, root: string): void {
  mkdirSync(root, { recursive: true });
  const temp = join(root, `backend-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, join(root, "backend.json"));
}

export function backendEnvironment(state: BackendState, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.CODEX_CLI_PATH;
  if (state.provider === "fork") {
    if (!state.installed || !existsSync(state.installed.executable)) {
      throw new Error("The selected fork CLI is missing. Reinstall it or explicitly select the desktop-bundled CLI.");
    }
    env.CODEX_CLI_PATH = state.installed.executable;
  }
  return env;
}

export function selectBackend(provider: string, root = userPaths().root): BackendState {
  if (provider !== "bundled" && provider !== "fork") throw new Error("CLI provider must be bundled or fork");
  const state = backendState(root);
  backendEnvironment({ ...state, provider }, {});
  save({ ...state, provider }, root);
  return backendState(root);
}

export function rollbackBackend(root = userPaths().root): BackendState {
  const state = backendState(root);
  if (!state.previous || !existsSync(state.previous.executable)) throw new Error("No previous fork package is available");
  save({ ...state, installed: state.previous, previous: state.installed }, root);
  return backendState(root);
}

export function backendAssetName(platform: string, arch: string): string {
  if (platform === "win32" && arch === "x64") return "codex-doca-x86_64-pc-windows-msvc.zip";
  if (platform === "darwin" && arch === "arm64") return "codex-doca-aarch64-apple-darwin.tar.gz";
  throw new Error(`No fork CLI package is configured for ${platform}/${arch}`);
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
        clientInfo: { name: "codexdc", title: "CodexDC compatibility check", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      } }) + "\n");
    });
    return version;
  } finally { rmSync(home, { recursive: true, force: true }); }
}

export async function installBackend(root = userPaths().root): Promise<BackendState> {
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, "backend-install.lock");
  let lock: number;
  try { lock = openSync(lockPath, "wx"); } catch { throw new Error("Another CLI installation is active. Retry when it finishes."); }
  const work = join(root, "cli", `.staging-${randomUUID()}`);
  try {
    const release: Release = await latestRelease(CLI_REPO);
    const asset = releaseAsset(release, backendAssetName(process.platform, process.arch));
    const sums = await downloadReleaseAsset(CLI_REPO, releaseAsset(release, "SHA256SUMS"));
    const digest = expectedChecksum(sums.toString("utf8"), asset.name);
    const bytes = await downloadReleaseAsset(CLI_REPO, asset);
    verifyChecksum(bytes, digest);
    mkdirSync(work, { recursive: true });
    const archive = join(work, asset.name);
    writeFileSync(archive, bytes);
    const unpacked = join(work, "package");
    await extractPackage(archive, unpacked);
    const relativeExe = join("bin", process.platform === "win32" ? "codex.exe" : "codex");
    const version = await probeBackend(validateBackendPackage(unpacked));
    const destination = join(root, "cli", `${release.id}-${process.platform}-${process.arch}-${digest.slice(0, 12)}`);
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
