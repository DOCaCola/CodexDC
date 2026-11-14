import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installWindowsRestartPolicy } from "../src/windows-restart-policy";

test("restart opt-out clears registration on startup and session shutdown; it never closes the app", async () => {
  const app = Object.assign(new EventEmitter(), { whenReady: async () => {} });
  const window = new EventEmitter();
  let registered = true;
  let calls = 0;
  const host = {
    unregisterRestart: () => { registered = false; calls++; },
    getRestartRegistration: () => registered ? { arguments: "", flags: 0 } : null,
  };
  installWindowsRestartPolicy({ app, host, log: () => {} });
  assert.equal(registered, false);
  await new Promise(resolve => setImmediate(resolve));
  registered = true;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.equal(registered, false, "a later updater registration is removed too");
  app.emit("browser-window-created", {}, window);
  for (const event of ["query-session-end", "session-end"]) {
    registered = true;
    window.emit(event);
    assert.equal(registered, false);
  }
  registered = true;
  app.emit("before-quit");
  assert.equal(registered, false);
  assert.ok(calls >= 4);
  app.emit("quit");
});

test("a failed initial opt-out is an explicit startup failure", () => {
  const app = Object.assign(new EventEmitter(), { whenReady: async () => {} });
  assert.throws(() => installWindowsRestartPolicy({
    app,
    host: { unregisterRestart: () => { throw new Error("denied"); }, getRestartRegistration: () => null },
    log: () => {},
  }), /denied/);
});
