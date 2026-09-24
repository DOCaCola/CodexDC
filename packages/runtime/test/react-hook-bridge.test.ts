import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(process.cwd(), "packages/runtime/src/preload/react-hook.ts"),
  "utf8",
);

test("React bridge inspects fibers in the page main world", () => {
  assert.match(source, /contextBridge\.executeInMainWorld/);
  assert.match(source, /Object\.getOwnPropertyNames\(target\)/);
  assert.match(source, /codexpp:react-fiber-request/);
  assert.match(source, /hydrateFiberSnapshot/);
});

test("React bridge retains direct and renderer-hook fallbacks", () => {
  assert.match(source, /findFiberByHostInstance/);
  assert.match(source, /Object\.getOwnPropertyNames\(node\)/);
  assert.match(source, /return fiberFromMainWorld\(node\)/);
});

test("React bridge caches same-turn projections and avoids duplicate alternate props", () => {
  assert.match(source, /mainWorldFiberCache\.has\(node\)/);
  assert.match(source, /queueMicrotask/);
  assert.match(source, /alternateProps === fiber\.memoizedProps/);
});
