import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tar from "tar";
import { extractPackage } from "../src/releases";

test("release extraction preserves complete package layout and executable mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-extract-"));
  try {
    const source = join(root, "source");
    mkdirSync(join(source, "bin"), { recursive: true });
    writeFileSync(join(source, "bin", "codex"), "executable");
    chmodSync(join(source, "bin", "codex"), 0o755);
    writeFileSync(join(source, "bin", "hpatch"), "companion");
    const archive = join(root, "package.tar.gz");
    await tar.c({ cwd: source, file: archive, gzip: true }, ["."]);
    const target = join(root, "target");
    await extractPackage(archive, target);
    assert.equal(readFileSync(join(target, "bin", "codex"), "utf8"), "executable");
    assert.equal(readFileSync(join(target, "bin", "hpatch"), "utf8"), "companion");
    if (process.platform !== "win32") assert.ok(statSync(join(target, "bin", "codex")).mode & 0o111);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid tar paths reject normally before any package file is extracted", async () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-extract-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "payload"), "untrusted");
    const archive = join(root, "package.tar.gz");
    await tar.c({ cwd: source, file: archive, gzip: true, prefix: "../escape" }, ["payload"]);
    await assert.rejects(extractPackage(archive, join(root, "target")), /Unsafe archive path/);
    assert.equal(existsSync(join(root, "escape")), false);
    assert.equal(existsSync(join(root, "target", "payload")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
