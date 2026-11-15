import assert from "node:assert/strict";
import test from "node:test";
import { withWindowsLaunchDiagnostics } from "../src/windows-launch-diagnostics";

test("a failed launch is saved and shown before the original error is propagated", async () => {
  const calls: string[] = [];
  const failure = new Error("Cannot terminate live Codex process 123: Access denied");
  const deps = {
    log: (message: string) => { calls.push(`log:${message}`); },
    showError: (message: string) => { calls.push(`dialog:${message}`); },
    reportDisplayFailure: () => { calls.push("display failed"); },
  };
  await assert.rejects(withWindowsLaunchDiagnostics(async () => { throw failure; }, deps), error => error === failure);
  assert.match(calls[0]!, /Launch requested/);
  assert.match(calls[1]!, /Launch failed.*Cannot terminate/);
  assert.equal(calls[2], `dialog:${failure.message}`);
  calls.length = 0;
  await withWindowsLaunchDiagnostics(async () => {}, deps);
  assert.deepEqual(calls, ["log:Launch requested"]);
});

test("a failed error dialog never hides the original launch failure", async () => {
  const failure = new Error("startup failed");
  let reported = false;
  await assert.rejects(withWindowsLaunchDiagnostics(async () => { throw failure; }, {
    log: () => {},
    showError: () => { throw new Error("dialog failed"); },
    reportDisplayFailure: () => { reported = true; },
  }), error => error === failure);
  assert.equal(reported, true);
});
