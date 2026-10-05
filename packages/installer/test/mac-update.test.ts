import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import test from "node:test";
import { applyMacUpdate, isNewerMacBuild } from "../src/mac-update.js";
const require = createRequire(import.meta.url);
const { attachManager, prepareHelper } = require("../../runtime/platform/macos/index.js");

test("macOS build comparison handles numeric builds, equality and downgrades", () => {
  assert.equal(isNewerMacBuild("9", "10"), true);
  assert.equal(isNewerMacBuild("26.9.9", "26.9.10"), true);
  assert.equal(isNewerMacBuild("26.9.10", "26.9.9"), false);
  assert.equal(isNewerMacBuild("26.9.10", "26.9.10.0"), false);
  assert.throws(() => isNewerMacBuild("undefined", "10"));
});
function fixture() {
  const calls: string[] = [];
  return { calls, services: {
    prepare: async (): Promise<string | undefined> => undefined,
    ready: () => { calls.push("ready"); },
    wait: async () => { calls.push("wait"); },
    repair: async () => { calls.push("repair"); },
    status: (error: string | null) => { calls.push(`status:${error}`); },
    launch: () => { calls.push("launch"); },
  } };
}
test("helper acknowledges readiness, waits, repairs and relaunches in order", async () => {
  const f = fixture(); await applyMacUpdate(123, f.services);
  assert.deepEqual(f.calls, ["ready", "wait", "repair", "status:null", "launch"]);
});
test("repair failure is saved and previous app reopened", async () => {
  const f = fixture(); f.services.repair = async () => { throw new Error("signing failed"); };
  await assert.rejects(applyMacUpdate(123, f.services), /signing failed/);
  assert.deepEqual(f.calls, ["ready", "wait", "status:signing failed", "launch"]);
});
test("helper rejects stale availability before acknowledging readiness", async () => {
  const f = fixture(); f.services.prepare = async () => { throw new Error("No newer release"); };
  await assert.rejects(applyMacUpdate(123, f.services), /No newer/);
  assert.deepEqual(f.calls, []);
});
test("exit timeout never repairs or relaunches a running app", async () => {
  const f = fixture(); f.services.wait = async () => { throw new Error("timeout"); };
  await assert.rejects(applyMacUpdate(123, f.services), /timeout/);
  assert.deepEqual(f.calls, ["ready"]);
});
function managerFixture() {
  const calls: string[] = [];
  const manager: any = { setUpdateReady: (v: boolean) => calls.push(`ready:${v}`), setDownloadProgressPercent: () => {}, setUpdateLifecycleState: (v: string) => calls.push(v) };
  const services = { check: async () => ({ ready: true }), prepare: async () => { calls.push("prepared"); }, quit: () => calls.push("quit"), message: async () => {}, error: async () => { calls.push("error"); } };
  attachManager(manager, services);
  return { manager, services, calls };
}
test("UI install waits for helper readiness before requesting quit", async () => {
  const f = managerFixture();
  assert.equal(await f.manager.installUpdatesIfAvailable(), true);
  assert.deepEqual(f.calls, ["ready:true", "downloading", "prepared", "installing", "quit"]);
  assert.equal(await f.manager.installUpdatesIfAvailable(), false);
});
test("helper failure leaves desktop open and update retryable", async () => {
  const f = managerFixture(); f.services.prepare = async () => { throw new Error("spawn failed"); };
  assert.equal(await f.manager.installUpdatesIfAvailable(), false);
  assert.deepEqual(f.calls, ["ready:true", "downloading", "ready", "error"]);
});
test("UI removes update readiness when installed update disappears", async () => {
  const f = managerFixture();
  assert.deepEqual(await f.manager.checkForUpdateInformation(), { status: "restart_required" });
  f.services.check = async () => ({ ready: false });
  assert.equal((await f.manager.checkForUpdateInformation()).status, "up_to_date");
  assert.equal(f.manager.getIsUpdateReady(), false);
  assert.equal(await f.manager.installUpdatesIfAvailable(), false);
  assert.equal(f.calls.includes("quit"), false);
});
test("helper spawn alone is not readiness; IPC acknowledgement is required", async () => {
  const child: any = new EventEmitter(); child.unref = () => {}; child.kill = () => {};
  let ready = false;
  const promise = prepareHelper(() => child, "/node", "/cli", {}, 12).then(() => { ready = true; });
  child.emit("spawn"); await Promise.resolve(); assert.equal(ready, false);
  child.emit("message", { type: "ready" }); await promise; assert.equal(ready, true);
});
test("helper early exit rejects readiness", async () => {
  const child: any = new EventEmitter(); child.kill = () => {};
  const promise = prepareHelper(() => child, "/node", "/cli", {}, 12);
  child.emit("exit", 1); await assert.rejects(promise, /before readiness/);
});

test("online release uses integrated update readiness and install action", async () => {
  const f = managerFixture();
  attachManager(f.manager, { ...f.services,
    check: async () => ({ ready: false, online: { build: "11645", version: "26.924.22138" } }),
  });
  assert.deepEqual(await f.manager.checkForUpdateInformation(), { status: "restart_required" });
  assert.equal(f.manager.getIsUpdateReady(), true);
  assert.equal(await f.manager.installUpdatesIfAvailable(), true);
  assert.ok(f.calls.indexOf("prepared") < f.calls.indexOf("quit"));
});
