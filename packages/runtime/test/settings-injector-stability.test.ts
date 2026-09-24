import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
  "utf8",
);

test("settings injector coalesces mutation observer work", () => {
  assert.match(source, /new MutationObserver\(scheduleInjection\)/);
  assert.match(source, /if \(state\.injectionFrame !== null\) return;/);
  assert.match(source, /state\.injectionFrame = requestAnimationFrame\(/);
});

test("settings injector preserves a validated sidebar during search filtering", () => {
  assert.match(
    source,
    /return allowKnownRoot && state\.sidebarRoot === el && el\.isConnected;/,
  );
  assert.match(source, /isSettingsSidebarCandidate\(node, true\)/);
  assert.match(source, /isSettingsSidebarCandidate\(outer, true\)/);
});
