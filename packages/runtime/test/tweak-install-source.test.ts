import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installedTweakSource, pullDevelopmentCheckout } from "../src/tweak-install-source";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexdc-dev-tweak-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, "upstream.git");
  const checkout = join(root, "checkout");
  const other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", upstream);
  git(root, "clone", "-q", upstream, checkout);
  mkdirSync(join(checkout, "tweaks", "colors"), { recursive: true });
  writeFileSync(join(checkout, "tweaks", "colors", "manifest.json"), "{\"version\":\"1.0.0\"}");
  commitFile(checkout, "base.txt", "base", "base");
  git(checkout, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", upstream, other);
  return { root, checkout, other };
}

test("installed tweaks are classified as Store, development link, or manual copy", (t) => {
  const { root, checkout } = fixture(t);
  const tweaks = join(root, "tweaks");
  mkdirSync(join(tweaks, "store"), { recursive: true });
  writeFileSync(join(tweaks, "store", ".codexpp-store.json"), "{}");
  mkdirSync(join(tweaks, "manual"));
  symlinkSync(join(checkout, "tweaks", "colors"), join(tweaks, "linked"), "junction");

  assert.deepEqual(installedTweakSource(join(tweaks, "store")), { kind: "store" });
  assert.deepEqual(installedTweakSource(join(tweaks, "manual")), { kind: "manual" });
  const linked = installedTweakSource(join(tweaks, "linked"));
  assert.equal(linked.kind, "development");
  assert.equal(linked.kind === "development" && git(linked.checkout, "rev-parse", "--show-toplevel"),
    git(checkout, "rev-parse", "--show-toplevel"));
});

test("pulling a development checkout rebases local commits onto upstream", async (t) => {
  const { checkout, other } = fixture(t);
  commitFile(other, "upstream.txt", "upstream", "upstream change");
  git(other, "push", "-q");
  commitFile(checkout, "local.txt", "local", "local change");

  const result = await pullDevelopmentCheckout(checkout);

  assert.notEqual(result.after, result.before);
  assert.equal(result.upstream, "origin/main");
  assert.equal(readFileSync(join(checkout, "upstream.txt"), "utf8"), "upstream");
  assert.equal(git(checkout, "log", "-1", "--format=%s"), "local change");
  assert.equal(git(checkout, "rev-list", "--count", "HEAD..origin/main"), "0");
});

test("pulling refuses a checkout with uncommitted changes", async (t) => {
  const { checkout } = fixture(t);
  writeFileSync(join(checkout, "base.txt"), "edited");

  await assert.rejects(pullDevelopmentCheckout(checkout), /uncommitted changes/);
  assert.equal(readFileSync(join(checkout, "base.txt"), "utf8"), "edited");
});

test("a conflicting pull is undone and leaves local commits in place", async (t) => {
  const { checkout, other } = fixture(t);
  commitFile(other, "base.txt", "upstream", "upstream edit");
  git(other, "push", "-q");
  commitFile(checkout, "base.txt", "local", "local edit");
  const before = git(checkout, "rev-parse", "HEAD");

  await assert.rejects(pullDevelopmentCheckout(checkout), /conflict with origin\/main\. The pull was undone/);
  assert.equal(git(checkout, "rev-parse", "HEAD"), before);
  assert.equal(git(checkout, "status", "--porcelain"), "");
});
