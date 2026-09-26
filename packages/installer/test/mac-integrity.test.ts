import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { macIntegrityDigest, macIntegrityDigestOffset, prepareMacIntegrityDigest } from "../src/mac-integrity.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const sentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
const old = { "Resources/app.asar": { algorithm: "SHA256", hash: "a".repeat(64) } };
test("native digest matches publisher dictionary serialization", () => {
  assert.deepEqual(macIntegrityDigest(old), createHash("sha256").update("Resources/app.asarSHA256" + "a".repeat(64)).digest());
});
test("digest slots distinguish disabled validation from malformed active formats", () => {
  assert.equal(macIntegrityDigestOffset(Buffer.concat([sentinel, Buffer.alloc(34)])), null);
  assert.throws(() => macIntegrityDigestOffset(Buffer.concat([sentinel, Buffer.from([1,2]), Buffer.alloc(32)])), /Unsupported/);
  assert.throws(() => macIntegrityDigestOffset(sentinel), /Invalid/);
});
test("native digest rewrite preserves other bytes and catches stale metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-integrity-"));
  const file = join(root, "Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework");
  const binary = Buffer.concat([Buffer.alloc(20, 7), sentinel, Buffer.from([1,1]), macIntegrityDigest(old), Buffer.alloc(20, 8)]);
  try {
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, binary);
    const update = prepareMacIntegrityDigest(root, old)!;
    const next = { "Resources/app.asar": { algorithm: "SHA256", hash: "b".repeat(64) } };
    update(next);
    const result = readFileSync(file);
    assert.deepEqual(result.subarray(0, 54), binary.subarray(0,54));
    assert.deepEqual(result.subarray(54,86), macIntegrityDigest(next));
    assert.deepEqual(result.subarray(86), binary.subarray(86));
    assert.throws(() => prepareMacIntegrityDigest(root, old), /does not match/);
    assert.ok(prepareMacIntegrityDigest(root, next));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
