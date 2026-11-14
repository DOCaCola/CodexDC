import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { desktopFingerprint, desktopStartupFiles } from "../src/desktop-fingerprint";

test("loaded startup identity changes when the loader, bootstrap, runtime or native policy changes", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-startup-hash-"));
  try {
    for (const name of desktopStartupFiles) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), name);
    }
    const before = desktopFingerprint(root, Buffer.from("loader"));
    assert.notEqual(desktopFingerprint(root, Buffer.from("new loader")), before);
    for (const name of desktopStartupFiles) {
      writeFileSync(join(root, name), "changed");
      assert.notEqual(desktopFingerprint(root, Buffer.from("loader")), before);
      writeFileSync(join(root, name), name);
    }
    assert.equal(desktopFingerprint(root, Buffer.from("loader")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
