import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  pruneWindowsStoreMirrors,
  removeWindowsStoreMirror,
} from "../src/windows-store-mirror-retention";

test("Store mirror retention keeps the active and immediately previous versions", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-store-retention-"));
  try {
    const storeRoot = join(root, "codexdc", "store-apps");
    const oldest = createMirror(storeRoot, "OpenAI.Codex_26.707.3748.0_x64__publisher");
    const previous = createMirror(storeRoot, "OpenAI.Codex_26.715.8383.0_x64__publisher");
    const active = createMirror(storeRoot, "OpenAI.Codex_26.715.9079.0_x64__publisher");
    mkdirSync(join(storeRoot, "custom-data"));

    const result = pruneWindowsStoreMirrors(active);

    assert.deepEqual(result.retained.map((path) => basename(path)).sort(), [
      "OpenAI.Codex_26.715.8383.0_x64__publisher",
      "OpenAI.Codex_26.715.9079.0_x64__publisher",
    ]);
    assert.deepEqual(result.removed, [join(storeRoot, "OpenAI.Codex_26.707.3748.0_x64__publisher")]);
    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(previous), true);
    assert.equal(existsSync(active), true);
    assert.equal(existsSync(join(storeRoot, "custom-data")), true);
    assert.deepEqual(result.failed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Store mirror retention always preserves an explicitly active older mirror", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-store-retention-"));
  try {
    const storeRoot = join(root, "codexdc", "store-apps");
    const active = createMirror(storeRoot, "OpenAI.Codex_26.707.3748.0_x64__publisher");
    const newest = createMirror(storeRoot, "OpenAI.Codex_26.715.9079.0_x64__publisher");
    const middle = createMirror(storeRoot, "OpenAI.Codex_26.715.8383.0_x64__publisher");

    const result = pruneWindowsStoreMirrors(active);

    assert.equal(existsSync(active), true);
    assert.equal(existsSync(newest), true);
    assert.equal(existsSync(middle), false);
    assert.equal(result.retained.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Store mirror retention ignores paths outside the managed Store root", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-store-retention-"));
  try {
    const appRoot = join(root, "OpenAI.Codex_26.715.9079.0_x64__publisher", "app");
    mkdirSync(appRoot, { recursive: true });

    assert.deepEqual(pruneWindowsStoreMirrors(appRoot), {
      storeRoot: null,
      retained: [],
      removed: [],
      failed: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Store mirror cleanup removes only the managed package root", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-store-retention-"));
  try {
    const storeRoot = join(root, "codexdc", "store-apps");
    const appRoot = createMirror(
      storeRoot,
      "OpenAI.Codex_26.818.3698.0_x64__publisher",
    );

    const result = removeWindowsStoreMirror(appRoot);

    assert.equal(result.removed, true);
    assert.equal(result.error, null);
    assert.equal(existsSync(appRoot), false);
    assert.equal(existsSync(storeRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Store mirror cleanup ignores paths outside the managed root", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-store-retention-"));
  try {
    const appRoot = join(
      root,
      "OpenAI.Codex_26.818.3698.0_x64__publisher",
      "app",
    );
    mkdirSync(appRoot, { recursive: true });

    assert.deepEqual(removeWindowsStoreMirror(appRoot), {
      packageRoot: null,
      removed: false,
      error: null,
    });
    assert.equal(existsSync(appRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createMirror(storeRoot: string, packageName: string): string {
  const appRoot = join(storeRoot, packageName, "app");
  const resources = join(appRoot, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "app.asar"), "");
  return appRoot;
}
