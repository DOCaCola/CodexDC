import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeTweakPath } from "../src/catalog-path";
import { selectTweakSource } from "../src/store-source";

test("collection installs select the exact catalog path, never the first manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-catalog-"));
  try {
    for (const name of ["aaa", "selected"]) {
      const dir = join(root, "repo-sha", "tweaks", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), "{}");
    }
    assert.equal(selectTweakSource(root, "tweaks/selected"), join(root, "repo-sha", "tweaks", "selected"));
    assert.throws(() => selectTweakSource(root), /No manifest/);
    assert.throws(() => selectTweakSource(root, "tweaks/missing"), /missing/);
    assert.throws(() => normalizeTweakPath("../other-repository"), /relative/);
    assert.throws(() => normalizeTweakPath("C:\\other"), /relative/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
