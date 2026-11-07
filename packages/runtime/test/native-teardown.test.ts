import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { NativeBridge } from "../src/native-bridge";

test("native teardown waits for module cleanup already started by a reload", async () => {
  const bridge = new NativeBridge(() => {});
  const modules = (bridge as unknown as {
    modules: Map<string, { tweakId: string; exports: { dispose(): Promise<void> } }>;
  }).modules;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  modules.set("module", { tweakId: "test", exports: { dispose: () => cleanup } });
  const reload = bridge.disposeTweak("test");
  let stopped = false;
  const update = bridge.disposeTweak("test").then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await Promise.all([reload, update]);
  assert.equal(stopped, true);
});

test("native teardown waits for the child to exit after requesting termination", async () => {
  const bridge = new NativeBridge(() => {});
  const helpers = (bridge as unknown as {
    helpers: Map<string, { tweakId: string; id: string; child: unknown }>;
  }).helpers;
  let terminated = false;
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, killed: false,
    kill() { terminated = true; child.killed = true; },
  });
  helpers.set("helper", { tweakId: "test", id: "helper", child });
  let stopped = false;
  const stopping = bridge.disposeTweak("test").then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, true);
  assert.equal(stopped, false);
  child.emit("exit", 0, null);
  await stopping;
  assert.equal(stopped, true);
});
