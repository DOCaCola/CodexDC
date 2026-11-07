import assert from "node:assert/strict";
import test from "node:test";
import { createTweakStoreClient } from "../src/preload/tweak-store-client";

function entry(id: string, status: "update" | "current" | null) {
  return {
    id,
    manifest: { id, name: id, version: "2.0.0" },
    installed: status === null ? null : { version: "1.0.0", enabled: true, source: "store", checkout: null, status, replaces: [] },
  };
}

function catalog(...entries: unknown[]) {
  return { schemaVersion: 1, sourceUrl: "store", fetchedAt: "now", entries };
}

test("subscribers follow the number of installed tweaks with updates", async () => {
  const responses: Array<() => Promise<unknown>> = [
    async () => catalog(entry("a", "update"), entry("b", "update"), entry("c", "current"), entry("d", null)),
    async () => {
      throw new Error("offline");
    },
  ];
  const store = createTweakStoreClient(() => responses.shift()!());
  const counts: Array<number | null> = [];
  store.subscribe((count) => counts.push(count));
  assert.equal(store.updateCount(), null);

  await store.load();
  assert.equal(store.updateCount(), 2);
  store.markInstalled("a");
  store.markInstalled("d");
  assert.equal(store.updateCount(), 1);
  assert.equal(await store.load(), store.current());

  await assert.rejects(store.load(true), /offline/);
  assert.equal(store.current(), null);
  assert.deepEqual(counts, [2, 1, null]);
});

test("only the latest catalog request updates subscribers", async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  const store = createTweakStoreClient(() => new Promise((resolve) => resolvers.push(resolve)));
  const counts: Array<number | null> = [];
  store.subscribe((count) => counts.push(count));
  const first = store.load();
  assert.equal(store.load(), first);
  const second = store.load(true);
  resolvers[1](catalog(entry("a", "current")));
  await second;
  resolvers[0](catalog(entry("a", "update")));
  await first;
  assert.equal(store.updateCount(), 0);
  assert.deepEqual(counts, [0]);
});
