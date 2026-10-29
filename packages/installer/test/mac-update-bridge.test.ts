import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);

function fixture(cached: boolean, supported = true, chunked = false) {
  const messages: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  const loads: string[] = [];
  let nativeInitializations = 0;
  let preparations = 0;
  let quits = 0;
  let updateReady = false;
  const manager = {
    getIsUpdateReady: () => updateReady,
    setUpdateReady: (ready: boolean) => { updateReady = ready; },
    installUpdatesIfAvailable: async () => { throw new Error("Native install must not run"); },
    initializeMacSparkle: async () => { nativeInitializations++; },
    setDownloadProgressPercent() {},
    setUpdateLifecycleState() {},
  };
  const singleton = supported ? {
    I: Function("manager", "return function(){ return { appUpdates: manager, setSparkleBridgeHandlers() {} }; }")(manager),
  } : { unrelated() {} };
  const loaded = chunked ? {
    ids: [339],
    modules: {
      35915(module: { exports: unknown }) {
        // Match the bundled module's semantics without executing its singleton early.
        const { appUpdates, setSparkleBridgeHandlers } = { appUpdates: manager, setSparkleBridgeHandlers() {} };
        module.exports = singleton;
      },
    },
  } : singleton;
  const filename = chunked ? "early-bootstrap-339-aea964a206c655e4.js" : "bootstrap-current.js";
  const moduleLoader = { _load: (request: string) => { loads.push(request); return loaded; } };
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(),
    quit: () => { quits++; },
  });
  const fakeRequire = Object.assign((name: string) => {
    if (name === "../updater-discovery.js") return require("../../runtime/platform/updater-discovery.js");
    if (name === "node:path") return path;
    if (name === "node:module") return moduleLoader;
    if (name === "node:fs") return {
      readFileSync: () => JSON.stringify({ sourceRoot: "/source", nodePath: "/node" }),
      existsSync: () => false,
    };
    if (name === "electron") return {
      app,
      dialog: { showMessageBox: async (options: { detail: string }) => { messages.push(options.detail); } },
    };
    if (name === "node:child_process") return {
      execFile: (_file: string, _args: string[], _options: unknown, callback: Function) => {
        callback(null, JSON.stringify({ ready: false, online: { version: "next" } }), "");
      },
      spawn: () => {
        preparations++;
        const child = Object.assign(new EventEmitter(), { unref() {}, kill() {} });
        queueMicrotask(() => child.emit("message", { type: "ready" }));
        return child;
      },
    };
    throw new Error(`Unexpected require: ${name}`);
  }, { cache: cached ? { bootstrap: { filename, exports: loaded } } : {} });
  const module = { exports: {} as { start(api: unknown): void } };
  runInNewContext(readFileSync(new URL("../../runtime/platform/macos/index.js", import.meta.url), "utf8"), {
    module, require: fakeRequire,
    process: { env: { CODEXDC_USER_ROOT: "/user" }, pid: 123 },
    setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout, clearTimeout,
  });
  module.exports.start({ log: {
    info: (message: string) => logs.push(message),
    warn: (message: string) => warnings.push(message),
  } });
  const loadDesktopWindow = () => {
    const contents = Object.assign(new EventEmitter(), {
      getType: () => "window", getURL: () => "app://-/index.html",
    });
    app.emit("web-contents-created", {}, contents);
    contents.emit("did-finish-load");
  };
  const executeChunk = () => {
    const chunk = loaded as { modules: Record<number, (module: { exports: unknown }) => void> };
    chunk.modules[35915]({ exports: {} });
  };
  return { manager, moduleLoader, messages, warnings, logs, loads, loadDesktopWindow, executeChunk, filename,
    counts: () => ({ nativeInitializations, preparations, quits }) };
}

for (const cached of [false, true]) {
  test(`macOS attaches to a ${cached ? "cached" : "newly loaded"} Rspack chunk before native initialization`, async () => {
    const state = fixture(cached, true, true);
    if (!cached) state.moduleLoader._load(`/app/.vite/build/${state.filename}`);
    assert.equal(state.logs.includes("macOS managed update bridge attached"), false);
    state.executeChunk();
    await state.manager.initializeMacSparkle();
    state.loadDesktopWindow();
    await Promise.resolve();
    assert.equal(state.logs.includes("macOS managed update bridge attached"), true);
    assert.deepEqual(state.warnings, []);
    assert.deepEqual(state.messages, []);
    assert.equal(await state.manager.installUpdatesIfAvailable(), true);
    assert.deepEqual(state.counts(), { nativeInitializations: 0, preparations: 1, quits: 1 });
  });
}

for (const cached of [false, true]) {
  test(`macOS intercepts the current ${cached ? "cached" : "newly loaded"} updater before native initialization`, async () => {
    const state = fixture(cached);
    if (!cached) state.moduleLoader._load("/app/bootstrap-current.js");
    await Promise.resolve();
    await state.manager.initializeMacSparkle();
    assert.equal(state.logs.includes("macOS managed update bridge attached"), true);
    assert.equal(state.manager.getIsUpdateReady(), true);
    assert.equal(await state.manager.installUpdatesIfAvailable(), true);
    assert.deepEqual(state.counts(), { nativeInitializations: 0, preparations: 1, quits: 1 });
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.warnings, []);
  });
}

test("unsupported desktops visibly report unavailable updates and never load native Sparkle", async () => {
  const state = fixture(true, false);
  await Promise.resolve();
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.warnings, []);
  state.loadDesktopWindow();
  await Promise.resolve();
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /could not attach.*in-place updater is disabled/);
  for (const request of ["/app/native/sparkle.node", "C:\\app\\native\\sparkle.node"]) {
    assert.throws(() => state.moduleLoader._load(request), /managed desktop updates are unavailable/i);
  }
  assert.deepEqual(state.loads, []);
  assert.equal(state.warnings.length, 1);
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.counts(), { nativeInitializations: 0, preparations: 0, quits: 0 });
});

test("app readiness before bootstrap loading does not report an attachment failure", async () => {
  const state = fixture(false);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.warnings, []);
  state.moduleLoader._load("/app/bootstrap-current.js");
  await Promise.resolve();
  state.loadDesktopWindow();
  await Promise.resolve();
  assert.equal(state.logs.includes("macOS managed update bridge attached"), true);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.warnings, []);
  assert.equal(await state.manager.installUpdatesIfAvailable(), true);
  assert.deepEqual(state.counts(), { nativeInitializations: 0, preparations: 1, quits: 1 });
});

test("a native Sparkle load before the desktop window is blocked and reported", async () => {
  const state = fixture(false, false);
  assert.throws(() => state.moduleLoader._load("/app/native/sparkle.node"), /managed desktop updates are unavailable/i);
  await Promise.resolve();
  assert.equal(state.messages.length, 1);
  assert.equal(state.warnings.length, 1);
  assert.deepEqual(state.loads, []);
  state.loadDesktopWindow();
  await Promise.resolve();
  assert.equal(state.messages.length, 1);
});
