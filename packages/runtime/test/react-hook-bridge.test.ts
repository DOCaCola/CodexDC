import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

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

test("React bridge preserves project metadata when ancestor props reference a cross-origin frame", () => {
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  class Element {
    attrs = new Map<string, string>();
    setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  }
  const module = { exports: {} as { installReactHook(): void } };
  runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, {
    module, exports: module.exports, Element, window: {},
    document: { addEventListener: (key: string, listener: (event: { target: unknown }) => void) => listeners.set(key, listener) },
    require: () => ({ contextBridge: { executeInMainWorld: ({ func, args }: { func: (...args: unknown[]) => void; args: unknown[] }) => func(...args) } }),
    queueMicrotask,
  });
  module.exports.installReactHook();
  const frame = new Proxy({}, {
    has() { throw new Error('Blocked a frame with origin "app://-" from accessing a cross-origin frame.'); },
  });
  let getterCalls = 0;
  const ancestorProps = Object.defineProperty({
    hostWindow: frame,
    hoverCardProjectId: "project-one",
    secondaryContent: { props: { projectGroup: { projectId: "project-one", projectKind: "local" } } },
  }, "frameAccessor", { enumerable: true, get() { getterCalls++; throw new Error("Getter must not run"); } });
  const cyclic: unknown[] = [];
  cyclic.push(cyclic, frame, "retained");
  const node = Object.assign(new Element(), {
    __reactFiber$test: {
      type: "div", memoizedProps: { id: "recent-row" },
      return: {
        type: function RecentRow() {},
        memoizedProps: ancestorProps,
        alternate: { memoizedProps: { hoverCardProjectId: "previous-project" } },
        return: { type: "div", memoizedProps: { values: cyclic }, return: null },
      },
    },
  });
  listeners.get("codexpp:react-fiber-request")!({ target: node });
  const snapshots = JSON.parse(node.attrs.get("data-codexpp-react-fiber-response")!);
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[1].memoizedProps.hoverCardProjectId, "project-one");
  assert.deepEqual(snapshots[1].memoizedProps.secondaryContent.props.projectGroup, { projectId: "project-one", projectKind: "local" });
  assert.equal("hostWindow" in snapshots[1].memoizedProps, false);
  assert.equal("frameAccessor" in snapshots[1].memoizedProps, false);
  assert.equal(getterCalls, 0);
  assert.equal(snapshots[1].alternateMemoizedProps.hoverCardProjectId, "previous-project");
  assert.deepEqual(snapshots[2].memoizedProps.values, [null, null, "retained"]);
});
