import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { findUpdaterSharedState, createUpdaterObserver, isUpdaterModulePath } = require("../../runtime/platform/updater-discovery.js");

function sharedState() {
  return {
    appUpdates: { getIsUpdateReady() { return false; }, installUpdatesIfAvailable() {} },
    setSparkleBridgeHandlers() {},
  };
}

function factory(state: unknown) {
  return Function("state", "return function(){ const { appUpdates, setSparkleBridgeHandlers } = state; return state; }")(state);
}

test("current desktop singleton is discovered through named and default exports", () => {
  const state = sharedState();
  const exportsValue = { I: factory(state) };
  assert.equal(findUpdaterSharedState(exportsValue), state);
  assert.equal(findUpdaterSharedState({ default: exportsValue }), state);
});

test("discovery rejects incomplete managers and continues to the current singleton", () => {
  const state = sharedState();
  assert.equal(findUpdaterSharedState({ invalid: factory({ appUpdates: {} }), I: factory(state) }), state);
  assert.equal(findUpdaterSharedState({ invalid: factory({ appUpdates: {} }) }), null);
});

test("obsolete singleton factories are not invoked", () => {
  let invoked = false;
  const manager = sharedState().appUpdates;
  const legacy = () => {
    invoked = true;
    return { sparkleManager: manager, setSparkleBridgeHandlers() {} };
  };
  assert.equal(findUpdaterSharedState({ legacy }), null);
  assert.equal(invoked, false);
});

test("async app startup exports are never invoked during singleton discovery", () => {
  let started = false;
  const startup = async () => {
    started = true;
    const { appUpdates, setSparkleBridgeHandlers } = sharedState();
    return { appUpdates, setSparkleBridgeHandlers };
  };
  assert.equal(findUpdaterSharedState({ runMainAppStartup: startup }), null);
  assert.equal(started, false);
});

test("bootstrap entry points and chunks are inspected without including renderer modules", () => {
  assert.equal(isUpdaterModulePath("/app/.vite/build/bootstrap-Du6FqCuH.js"), true);
  assert.equal(isUpdaterModulePath("C:\\app\\bootstrap-current.js"), true);
  assert.equal(isUpdaterModulePath("/app/.vite/build/early-bootstrap.js"), true);
  assert.equal(isUpdaterModulePath("/app/.vite/build/early-bootstrap-339-aea964a206c655e4.js"), true);
  assert.equal(isUpdaterModulePath("C:\\app\\early-bootstrap-339-current.js"), true);
  assert.equal(isUpdaterModulePath("window-all-closed-old.js"), false);
  assert.equal(isUpdaterModulePath("renderer-bootstrap-current.js"), false);
  assert.equal(isUpdaterModulePath("renderer-early-bootstrap-current.js"), false);
});

test("chunk discovery waits for module execution and attaches before its importer resumes", () => {
  const state = sharedState();
  const events: string[] = [];
  const chunk = {
    ids: [339],
    modules: {
      35915(module: { exports: unknown }, exports: Record<string, unknown>, require: unknown) {
        assert.equal(this, chunk.modules);
        assert.equal(require, "bundler require");
        events.push("execute");
        exports.q = () => {
          events.push("singleton");
          const { appUpdates, setSparkleBridgeHandlers } = state;
          return { appUpdates, setSparkleBridgeHandlers };
        };
        return "module result";
      },
      123() { throw new Error("Unrelated modules must not execute"); },
    },
  };
  const original = chunk.modules[35915];
  const unrelated = chunk.modules[123];
  const observer = createUpdaterObserver((shared: unknown) => {
    assert.deepEqual(shared, state);
    events.push("attached");
  });
  observer.inspect(chunk);
  const wrapped = chunk.modules[35915];
  observer.inspect(chunk);
  assert.equal(chunk.modules[35915], wrapped);
  assert.equal(chunk.modules[123], unrelated);
  assert.deepEqual(events, []);
  const module = { exports: {} };
  assert.equal(chunk.modules[35915](module, module.exports, "bundler require"), "module result");
  events.push("importer resumed");
  assert.deepEqual(events, ["execute", "singleton", "attached", "importer resumed"]);
  observer.stop();
  assert.equal(chunk.modules[35915], original);
  events.length = 0;
  wrapped.call(chunk.modules, { exports: {} }, {}, "bundler require");
  assert.deepEqual(events, ["execute"], "a bundler's retained wrapper must be inert after stop");
});
