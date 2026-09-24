import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backendAssetName, backendEnvironment, backendState, rollbackBackend, selectBackend, configureDevelopmentBackend } from "../src/backend";
import { containedArchivePath, expectedChecksum, releaseAsset, verifyChecksum } from "../src/releases";

test("bundled backend removes inherited override without changing the parent environment", () => {
  const parent = { CODEX_CLI_PATH: "unrelated-cli", PATH: "unchanged" };
  const next = backendEnvironment({ provider: "bundled" }, parent);
  assert.equal(next.CODEX_CLI_PATH, undefined);
  assert.equal(next.PATH, parent.PATH);
  assert.equal(parent.CODEX_CLI_PATH, "unrelated-cli");
});

test("development selection uses the live build and preserves selection on failed validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-dev-cli-"));
  try {
    const executable = join(root, "codex.exe");
    writeFileSync(executable, "fixture");
    await configureDevelopmentBackend(executable, root, async (path) => {
      assert.equal(path, executable);
      return "development";
    });
    assert.equal(backendEnvironment(backendState(root), {}).CODEX_CLI_PATH, executable);
    const before = readFileSync(join(root, "backend.json"), "utf8");
    await assert.rejects(configureDevelopmentBackend("broken", root, async () => { throw new Error("probe failed"); }), /probe failed/);
    assert.equal(readFileSync(join(root, "backend.json"), "utf8"), before);
    selectBackend("bundled", root);
    selectBackend("development", root);
    rmSync(executable);
    assert.throws(() => backendEnvironment(backendState(root), {}), /development CLI is missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selection and rollback preserve complete package paths; failed selections do not change state", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-backend-"));
  try {
    assert.deepEqual(backendState(root), { provider: "bundled" });
    const one = join(root, "cli", "v1", "bin", "codex");
    const two = join(root, "cli", "v2", "bin", "codex");
    for (const path of [one, two]) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "fixture"); }
    const pkg = (executable: string, tag: string) => ({ executable, tag, version: tag, releaseId: 1, digest: "fixture" });
    writeFileSync(join(root, "backend.json"), JSON.stringify({ provider: "bundled", installed: pkg(two, "2"), previous: pkg(one, "1") }));
    selectBackend("fork", root);
    assert.equal(backendEnvironment(backendState(root), {}).CODEX_CLI_PATH, two);
    rollbackBackend(root);
    assert.equal(backendState(root).installed?.executable, one);
    rmSync(one);
    const before = readFileSync(join(root, "backend.json"), "utf8");
    assert.throws(() => selectBackend("fork", root), /missing/);
    assert.equal(readFileSync(join(root, "backend.json"), "utf8"), before);
    selectBackend("bundled", root);
    assert.equal(backendState(root).provider, "bundled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release selection requires the exact architecture and an unambiguous checksum", () => {
  assert.equal(backendAssetName("darwin", "arm64"), "codex-doca-aarch64-apple-darwin.tar.gz");
  assert.throws(() => backendAssetName("darwin", "x64"), /No DC fork CLI package/);
  const bytes = Buffer.from("complete package");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(expectedChecksum(`${digest}  package.zip\n`, "package.zip"), digest);
  assert.throws(() => expectedChecksum(`${digest}  package.zip\n${digest}  package.zip`, "package.zip"), /ambiguous/);
  verifyChecksum(bytes, digest);
  assert.throws(() => verifyChecksum(Buffer.from("changed"), digest), /mismatch/);
  assert.throws(() => releaseAsset({ id: 1, tag_name: "v1", html_url: "", draft: false, prerelease: false, assets: [] }, "mac.tar.gz"), /no unique/);
});

test("archive paths cannot escape staging on either host OS", () => {
  for (const path of ["../escape", "bin/../../escape", "/absolute", "C:/absolute", "bin\\..\\escape", "bin/codex:stream"]) {
    assert.throws(() => containedArchivePath(tmpdir(), path), /Unsafe/);
  }
  assert.equal(containedArchivePath(tmpdir(), "bin/codex.exe"), join(tmpdir(), "bin", "codex.exe"));
});
