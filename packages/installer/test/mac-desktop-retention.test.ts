import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { confirmMacDesktopStartup, isConfirmedMacInstall, pruneMacDesktopReleases, replaceMacRollback, shouldRotateMacBackup } from "../src/mac-desktop-retention.js";
import type { InstallerState } from "../src/state.js";

test("only a confirmed different build replaces an existing last-working backup", () => {
  assert.equal(shouldRotateMacBackup(true, "100", "101", true), true);
  assert.equal(shouldRotateMacBackup(true, "100", "100", true), false);
  assert.equal(shouldRotateMacBackup(false, "101", "102", true), false);
  assert.equal(shouldRotateMacBackup(false, "101", "102", false), false);
  assert.equal(shouldRotateMacBackup(true, "100", "100", false), true);
});
test("startup confirmation belongs to the exact installation, not only its version", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-retention-"));
  const state = { installedAt: "2026-10-05", patchedAsarHash: "hash" } as InstallerState;
  try {
    assert.equal(isConfirmedMacInstall(root, state), false);
    writeFileSync(join(root, "mac-working-state.json"), JSON.stringify(state));
    assert.equal(isConfirmedMacInstall(root, state), true);
    assert.equal(isConfirmedMacInstall(root, { ...state, installedAt: "next" }), false);
    assert.equal(isConfirmedMacInstall(root, { ...state, patchedAsarHash: "other" }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("pruning keeps active and prepared sources; removes older releases and incomplete downloads", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-retention-"));
  const cache = join(root, "desktop-releases");
  const app = (name: string) => join(cache, name, "extracted", "ChatGPT.app");
  try {
    for (const name of ["release-active", "release-prepared", "release-old", "release-partial", "notes"]) mkdirSync(app(name), { recursive: true });
    symlinkSync(join(cache, "notes"), join(cache, "release-link"), "dir");
    const result = pruneMacDesktopReleases(root, [app("release-active"), app("release-prepared")]);
    assert.equal(result.retained.length, 2);
    assert.equal(result.removed.length, 2);
    assert.ok(existsSync(app("release-active")) && existsSync(app("release-prepared")));
    assert.ok(existsSync(join(cache, "notes")) && existsSync(join(cache, "release-link")));
    assert.equal(existsSync(app("release-old")), false);
    assert.equal(existsSync(app("release-partial")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("invalid source references fail before deleting any managed release", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-retention-"));
  try {
    const candidate = join(root, "desktop-releases/release-old"); mkdirSync(candidate, { recursive: true });
    assert.throws(() => pruneMacDesktopReleases(root, ["/Applications/ChatGPT.app"]), /outside/);
    assert.ok(existsSync(candidate));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("rollback rotation retains one app and its matching runtime/state snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-retention-"));
  const app = join(root, "CodexDC.app"), displaced = join(root, ".displaced"), snapshot = join(root, ".snapshot");
  const backup = `${app}.previous`, metadata = join(root, "desktop-rollback");
  try {
    for (const p of [displaced, snapshot, backup, metadata]) mkdirSync(p);
    writeFileSync(join(displaced, "build"), "working"); writeFileSync(join(snapshot, "state.json"), "working-state");
    replaceMacRollback(app, displaced, snapshot, root);
    assert.equal(readFileSync(join(backup, "build"), "utf8"), "working");
    assert.equal(readFileSync(join(metadata, "state.json"), "utf8"), "working-state");
    assert.equal(existsSync(displaced), false); assert.equal(existsSync(snapshot), false);
    assert.equal(existsSync(`${displaced}.retired`), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("rotation failure preserves the old rollback and displaced current app", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-retention-"));
  const app = join(root, "CodexDC.app"), displaced = join(root, ".displaced"), snapshot = join(root, ".missing");
  try {
    mkdirSync(`${app}.previous`); writeFileSync(join(`${app}.previous`, "build"), "last-working");
    mkdirSync(displaced); writeFileSync(join(displaced, "build"), "current");
    assert.throws(() => replaceMacRollback(app, displaced, snapshot, root));
    assert.equal(readFileSync(join(`${app}.previous`, "build"), "utf8"), "last-working");
    assert.equal(readFileSync(join(displaced, "build"), "utf8"), "current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("startup refusal releases its locks without pruning releases", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-retention-"));
  const original = process.env.CODEXDC_HOME;
  process.env.CODEXDC_HOME = root;
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ managedCopy: true, installedAt: "current" }));
    const release = join(root, "desktop-releases/release-active"); mkdirSync(release, { recursive: true });
    assert.throws(() => confirmMacDesktopStartup("stale"), /does not match/);
    assert.equal(existsSync(join(root, "mac-update.lock")), false);
    assert.equal(existsSync(join(root, "managed-install.lock")), false);
    assert.ok(existsSync(release));
    writeFileSync(join(root, "managed-install.lock"), "busy");
    assert.throws(() => confirmMacDesktopStartup("current"), /EEXIST/);
    assert.equal(existsSync(join(root, "mac-update.lock")), false);
    assert.ok(existsSync(join(root, "managed-install.lock")));
  } finally {
    if (original === undefined) delete process.env.CODEXDC_HOME;
    else process.env.CODEXDC_HOME = original;
    rmSync(root, { recursive: true, force: true });
  }
});
