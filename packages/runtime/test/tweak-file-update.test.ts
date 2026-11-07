import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import chokidar from "chokidar";
import { replaceStoreTweak, TweakFileUpdates } from "../src/tweak-file-update";

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "codexdc-store-activation-"));
  const tweaks = join(root, "tweaks");
  const target = join(tweaks, "local.codex-lb");
  const staged = join(root, "staged");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(staged);
  fs.writeFileSync(join(target, "index.js"), "original");
  fs.writeFileSync(join(staged, "index.js"), "updated");
  return { root, tweaks, target, staged };
}

test("activation closes its watcher and awaits teardown before switching, then reloads once", async () => {
  const f = fixture();
  const updates = new TweakFileUpdates();
  const order: string[] = [];
  const watcher = chokidar.watch(f.tweaks, { ignoreInitial: true });
  await new Promise<void>((resolve) => watcher.once("ready", resolve));
  try {
    await updates.run(() => updates.activate(() => {
      assert.equal(updates.reloadsPaused, true);
      replaceStoreTweak(f.staged, f.target, f.tweaks);
      order.push("activate");
    }, {
      async closeWatcher() { await watcher.close(); order.push("closed"); },
      async stopTweaks() { await new Promise((r) => setImmediate(r)); order.push("stopped"); },
      reloadTweaks() {
        assert.equal(fs.readFileSync(join(f.target, "index.js"), "utf8"), "updated");
        order.push("reload");
      },
      startWatcher() { order.push("watch"); },
    }));
    assert.deepEqual(order, ["closed", "stopped", "activate", "reload", "watch"]);
    assert.equal(updates.reloadsPaused, false);
    assert.deepEqual(fs.readdirSync(f.tweaks), ["local.codex-lb"]);
  } finally {
    await watcher.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a locked original stays installed and temporary staging is cleaned", () => {
  const f = fixture();
  try {
    assert.throws(() => replaceStoreTweak(f.staged, f.target, f.tweaks, {
      ...fs,
      renameSync(from, to) {
        if (from === f.target) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        fs.renameSync(from, to);
      },
    }), /existing tweak was preserved/);
    assert.equal(fs.readFileSync(join(f.target, "index.js"), "utf8"), "original");
    assert.deepEqual(fs.readdirSync(f.tweaks), ["local.codex-lb"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed publication restores the previous version", () => {
  const f = fixture();
  try {
    assert.throws(() => replaceStoreTweak(f.staged, f.target, f.tweaks, {
      ...fs,
      renameSync(from, to) {
        if (basename(String(from)) === "next") throw new Error("publication failed");
        fs.renameSync(from, to);
      },
    }), /publication failed/);
    assert.equal(fs.readFileSync(join(f.target, "index.js"), "utf8"), "original");
    assert.deepEqual(fs.readdirSync(f.tweaks), ["local.codex-lb"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed rollback retains the only original copy and reports its recovery path", () => {
  const f = fixture();
  try {
    assert.throws(() => replaceStoreTweak(f.staged, f.target, f.tweaks, {
      ...fs,
      renameSync(from, to) {
        if (from !== f.target) throw new Error("rename denied");
        fs.renameSync(from, to);
      },
    }), /original tweak is preserved at/);
    const backup = join(f.tweaks, fs.readdirSync(f.tweaks)[0], "previous", "index.js");
    assert.equal(fs.readFileSync(backup, "utf8"), "original");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("teardown failure prevents replacement and restores reloads; queued operations still run", async () => {
  const updates = new TweakFileUpdates();
  const order: string[] = [];
  const first = updates.run(() => updates.activate(() => {
    order.push("must not activate");
  }, {
    async closeWatcher() { order.push("close"); },
    async stopTweaks() { await new Promise((r) => setImmediate(r)); throw new Error("stop failed"); },
    reloadTweaks() { order.push("reload"); },
    startWatcher() { order.push("watch"); },
  }));
  const second = updates.run(() => {
    assert.equal(updates.reloadsPaused, false);
    order.push("next update");
  });
  await assert.rejects(first, /stop failed/);
  await second;
  assert.deepEqual(order, ["close", "reload", "watch", "next update"]);
});

test("Windows sharing lock preserves the install; replacement works after releasing it",
  { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
    const f = fixture();
    const child = spawn("powershell.exe", ["-NoProfile", "-Command",
      "$stream = [IO.File]::Open($env:CODEXDC_TEST_LOCK_FILE, 'Open', 'Read', 'Read'); " +
      "try { [Console]::WriteLine('locked'); [Console]::ReadLine() | Out-Null } finally { $stream.Dispose() }",
    ], { env: { ...process.env, CODEXDC_TEST_LOCK_FILE: join(f.target, "index.js") }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    try {
      const [ready] = await once(lines, "line");
      assert.equal(ready, "locked");
      assert.throws(() => replaceStoreTweak(f.staged, f.target, f.tweaks), /existing tweak was preserved/);
      assert.equal(fs.readFileSync(join(f.target, "index.js"), "utf8"), "original");
      child.stdin.end("\n");
      await closed;
      replaceStoreTweak(f.staged, f.target, f.tweaks);
      assert.equal(fs.readFileSync(join(f.target, "index.js"), "utf8"), "updated");
    } finally {
      child.stdin.end("\n");
      await closed;
      lines.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
