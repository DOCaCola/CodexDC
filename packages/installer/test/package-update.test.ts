import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updatePackageFrom } from "../src/package-update";
import { userPaths } from "../src/paths";
import type { Release, ReleaseAsset } from "../src/releases";

function fixture() {
  const work = mkdtempSync(join(tmpdir(), "CodexDC update test "));
  const root = join(work, "user");
  const paths: ReturnType<typeof userPaths> = {
    root, runtime: join(root, "runtime"), tweaks: join(root, "tweaks"), backup: join(root, "backup"),
    configFile: join(root, "config.json"), stateFile: join(root, "state.json"),
    updateModeFile: join(root, "update-mode.json"), selfUpdateStateFile: join(root, "self-update-state.json"),
    binDir: join(root, "bin"), logDir: join(root, "log"),
  };
  mkdirSync(paths.runtime, { recursive: true });
  writeFileSync(join(paths.runtime, "version"), "old-runtime");
  const old = join(work, "old-package");
  mkdirSync(old);
  const install = { appRoot: join(work, "managed-app"), sourceRoot: old, nodePath: process.execPath };
  writeFileSync(paths.stateFile, JSON.stringify(install));
  writeFileSync(join(root, "maintenance-selection.json"), JSON.stringify({ active: old, previous: null }));
  const source = join(work, "source");
  mkdirSync(source);
  writeFileSync(join(source, "codexdc-release.json"), JSON.stringify({ version: "9.0.0", target: `${process.platform}-${process.arch}` }));
  const name = `CodexDC-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const archive = join(work, name);
  const tar = process.platform === "win32" ? join(process.env.SystemRoot!, "System32", "tar.exe") : "/usr/bin/tar";
  execFileSync(tar, [process.platform === "win32" ? "-a" : "-z", "-cf", archive, "-C", source, "."]);
  const bytes = readFileSync(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const release: Release = { id: 1, tag_name: "v9.0.0", html_url: "https://github.com/DOCaCola/CodexDC/releases/tag/v9.0.0",
    draft: false, prerelease: false, assets: [name, "SHA256SUMS"].map((name) => ({ name, size: 0, browser_download_url: "" })) };
  const calls: { root: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  let checks = 0;
  const services = {
    latestRelease: async () => { checks++; return release; },
    downloadReleaseAsset: async (_repo: string, asset: ReleaseAsset) => asset.name === name ? bytes : Buffer.from(`${digest}  ${name}\n`),
    isCodexRunning: () => false,
    runCli: (_node: string, args: string[], root: string, env: NodeJS.ProcessEnv) => {
      calls.push({ root, args, env });
      if (args[1] === "repair") {
        writeFileSync(join(paths.runtime, "version"), root === old ? "old-runtime" : "new-runtime");
      }
      return Buffer.alloc(0);
    },
  };
  return { work, root, paths, old, services, calls, checks: () => checks,
    cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

test("launch activates a complete package and preserves context through candidate validation and repair", async () => {
  const f = fixture();
  try {
    await updatePackageFrom(f.old, f.paths, { onLaunch: true, quiet: true }, f.services);
    const selection = JSON.parse(readFileSync(join(f.root, "maintenance-selection.json"), "utf8"));
    assert.equal(selection.previous, f.old);
    assert.notEqual(selection.active, f.old);
    assert.deepEqual(f.calls.map((c) => c.args.slice(1)), [["--help"], ["repair", "--force", "--quiet"]]);
    for (const call of f.calls) {
      assert.equal(call.root, selection.active);
      assert.equal(call.env.CODEXDC_ACTIVATING, "1");
      assert.equal(call.env.CODEXDC_HOME, f.root);
    }
    assert.equal(readFileSync(join(f.paths.runtime, "version"), "utf8"), "new-runtime");
    assert.equal(JSON.parse(readFileSync(f.paths.selfUpdateStateFile, "utf8")).status, "updated");
  } finally { f.cleanup(); }
});

test("failed candidate repair restores the runtime and keeps the old package active", async () => {
  const f = fixture();
  const run = f.services.runCli;
  f.services.runCli = (node, args, root, env) => {
    const result = run(node, args, root, env);
    if (args[1] === "repair" && root !== f.old) throw new Error("candidate repair failed");
    return result;
  };
  try {
    await assert.rejects(updatePackageFrom(f.old, f.paths, { onLaunch: true, quiet: true }, f.services), /previous installation restored/);
    assert.equal(readFileSync(join(f.paths.runtime, "version"), "utf8"), "old-runtime");
    assert.equal(JSON.parse(readFileSync(join(f.root, "maintenance-selection.json"), "utf8")).active, f.old);
    assert.equal(f.calls.at(-1)?.root, f.old);
    assert.equal(f.calls.at(-1)?.env.CODEXDC_ACTIVATING, "1");
    assert.equal(JSON.parse(readFileSync(f.paths.selfUpdateStateFile, "utf8")).status, "failed");
  } finally { f.cleanup(); }
});

test("launch waits while the desktop is open without consuming its next release check", async () => {
  const f = fixture();
  f.services.isCodexRunning = () => true;
  try {
    await updatePackageFrom(f.old, f.paths, { onLaunch: true }, f.services);
    assert.equal(f.checks(), 0);
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(f.paths.selfUpdateStateFile), false);
    await assert.rejects(updatePackageFrom(f.old, f.paths, {}, f.services), /Close CodexDC/);
  } finally { f.cleanup(); }
});

test("launch respects disabled updates and throttles completed release checks", async () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.configFile, JSON.stringify({ codexPlusPlus: { autoUpdate: false } }));
    await updatePackageFrom(f.old, f.paths, { onLaunch: true }, f.services);
    assert.equal(f.checks(), 0);
    rmSync(f.paths.configFile);
    writeFileSync(f.paths.selfUpdateStateFile, JSON.stringify({ checkedAt: new Date().toISOString() }));
    await updatePackageFrom(f.old, f.paths, { onLaunch: true }, f.services);
    assert.equal(f.checks(), 0);
  } finally { f.cleanup(); }
});
