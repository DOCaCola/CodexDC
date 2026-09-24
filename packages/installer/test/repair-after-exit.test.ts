import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import {
  parseProcessId,
  waitForSuccessfulLaunch,
  waitForProcessExit,
} from "../src/commands/repair-after-exit";

test("repair-after-exit validates process ids", () => {
  assert.equal(parseProcessId("1234"), 1234);
  assert.throws(() => parseProcessId("0"), /Invalid process id/);
  assert.throws(() => parseProcessId("not-a-pid"), /Invalid process id/);
});

test("repair-after-exit waits until the target process is gone", async () => {
  let checks = 0;
  const progress: string[] = [];
  await waitForProcessExit(1234, {
    pollIntervalMs: 1,
    timeoutMs: 100,
    isRunning: () => checks++ < 2,
    onProgress: (message) => progress.push(message),
    progressIntervalMs: 0,
  });
  assert.equal(checks, 3);
  assert.match(progress[0] ?? "", /Still waiting for CodexDC process 1234 to exit/);
});

test("repair-after-exit reports a timeout", async () => {
  await assert.rejects(
    waitForProcessExit(1234, {
      pollIntervalMs: 1,
      timeoutMs: 3,
      isRunning: () => true,
    }),
    /Timed out waiting for process 1234/,
  );
});

test("repair-after-exit rejects a patched app that exits during startup", async () => {
  const child = fakeChild();
  setTimeout(() => child.emit("exit", 3, null), 1);
  await assert.rejects(
    waitForSuccessfulLaunch(child as ChildProcess, { graceMs: 50 }),
    /exited during startup validation \(exit code 3\)/,
  );
});

test("repair-after-exit accepts a patched app that survives the startup grace period", async () => {
  const child = fakeChild();
  await waitForSuccessfulLaunch(child as ChildProcess, { graceMs: 5 });
});

test("repair-after-exit reports spawn errors during startup validation", async () => {
  const child = fakeChild();
  setTimeout(() => child.emit("error", new Error("spawn failed")), 1);
  await assert.rejects(
    waitForSuccessfulLaunch(child as ChildProcess, { graceMs: 50 }),
    /spawn failed/,
  );
});

function fakeChild(): EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  });
}
