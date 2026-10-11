import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { findUpdaterSharedState, isUpdaterModulePath } = require("../../runtime/platform/updater-discovery.js");

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

test("only the current bootstrap module is inspected", () => {
  assert.equal(isUpdaterModulePath("/app/.vite/build/bootstrap-Du6FqCuH.js"), true);
  assert.equal(isUpdaterModulePath("C:\\app\\bootstrap-current.js"), true);
  assert.equal(isUpdaterModulePath("window-all-closed-old.js"), false);
  assert.equal(isUpdaterModulePath("renderer-bootstrap-current.js"), false);
});
