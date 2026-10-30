import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import kleur from "kleur";
import { updateDevelopmentCheckout } from "../src/development-update";

function fixture() {
  const work = mkdtempSync(join(tmpdir(), "CodexDC development update "));
  const upstream = join(work, "upstream");
  const checkout = join(work, "checkout");
  mkdirSync(upstream);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" },
  }).trim();
  git(upstream, "init");
  writeFileSync(join(upstream, "source"), "original");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "initial");
  git(work, "clone", upstream, checkout);
  const advance = () => {
    writeFileSync(join(upstream, "source"), "updated");
    git(upstream, "commit", "-am", "upstream update");
  };
  const calls: string[] = [];
  const services = {
    build: (root: string) => { assert.equal(root, checkout); calls.push("build"); },
    log: (message: string) => calls.push(`log:${message}`),
    warn: (message: string) => calls.push(`warn:${message}`),
  };
  return { work, upstream, checkout, git, advance, calls, services,
    cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

test("clean development checkout pulls its upstream and rebuilds only when commits change", () => {
  const f = fixture();
  try {
    assert.equal(updateDevelopmentCheckout(f.checkout, true, true, f.services), false);
    assert.deepEqual(f.calls, []);
    f.advance();
    assert.equal(updateDevelopmentCheckout(f.checkout, true, true, f.services), true);
    assert.equal(readFileSync(join(f.checkout, "source"), "utf8"), "updated");
    assert.deepEqual(f.calls, ["build"]);
    assert.equal(updateDevelopmentCheckout(f.checkout, true, true, f.services), false);
    assert.deepEqual(f.calls, ["build"]);
  } finally { f.cleanup(); }
});

for (const change of ["unstaged", "staged", "untracked", "commit"]) {
  test(`development startup preserves ${change} changes and warns without pulling`, () => {
    const f = fixture();
    try {
      f.advance();
      if (change === "untracked") {
        writeFileSync(join(f.checkout, "local-file"), "local");
      } else {
        writeFileSync(join(f.checkout, "source"), "local");
        if (change !== "unstaged") f.git(f.checkout, "add", ".");
        if (change === "commit") f.git(f.checkout, "commit", "-m", "local commit");
      }
      const before = f.git(f.checkout, "rev-parse", "HEAD");
      const status = f.git(f.checkout, "status", "--porcelain");
      assert.equal(updateDevelopmentCheckout(f.checkout, true, true, f.services), false);
      assert.equal(f.git(f.checkout, "rev-parse", "HEAD"), before);
      assert.equal(f.git(f.checkout, "status", "--porcelain"), status);
      assert.equal(f.calls.length, 1);
      assert.match(f.calls[0], /warn:.*local (?:changes|commits).*continuing startup/);
    } finally { f.cleanup(); }
  });
}

test("disabled development updates still warn about local changes", () => {
  const f = fixture();
  try {
    f.advance();
    assert.equal(updateDevelopmentCheckout(f.checkout, true, false, f.services), false);
    assert.equal(readFileSync(join(f.checkout, "source"), "utf8"), "original");
    writeFileSync(join(f.checkout, "source"), "local");
    assert.equal(updateDevelopmentCheckout(f.checkout, true, false, f.services), false);
    assert.match(f.calls[0], /warn:.*local changes/);
  } finally { f.cleanup(); }
});

test("local development warning is yellow even with quiet output", () => {
  const f = fixture();
  const enabled = kleur.enabled;
  const warn = console.warn;
  const warnings: string[] = [];
  try {
    writeFileSync(join(f.checkout, "source"), "local");
    kleur.enabled = true;
    console.warn = (message: string) => { warnings.push(message); };
    assert.equal(updateDevelopmentCheckout(f.checkout, true), false);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(String.fromCharCode(27) + "[33m"));
  } finally {
    kleur.enabled = enabled;
    console.warn = warn;
    f.cleanup();
  }
});

test("a failed development pull leaves the current checkout intact", () => {
  const f = fixture();
  try {
    const before = f.git(f.checkout, "rev-parse", "HEAD");
    f.git(f.checkout, "remote", "set-url", "origin", join(f.work, "missing"));
    assert.throws(() => updateDevelopmentCheckout(f.checkout, true, true, f.services));
    assert.equal(f.git(f.checkout, "rev-parse", "HEAD"), before);
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});
