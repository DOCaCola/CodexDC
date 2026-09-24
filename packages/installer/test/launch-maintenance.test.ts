import assert from "node:assert/strict";
import test from "node:test";
import { maintainBeforeLaunch } from "../src/launch-maintenance";
import { UpdateRecoveryError } from "../src/package-update";
import type { InstallerState } from "../src/state";
import { CODEXDC_VERSION } from "../src/version";

function fixture() {
  const calls: string[] = [];
  const state = { appRoot: "/managed", version: CODEXDC_VERSION } as InstallerState;
  const services = {
    readInstall: () => state,
    isRunning: () => false,
    update: async (): Promise<string | undefined> => { calls.push("update"); return undefined; },
    repair: async (force: boolean) => { calls.push(`repair:${force}`); },
    report: (error: unknown) => { calls.push(`report:${String(error)}`); },
  };
  return { calls, state, services };
}

test("launch checks for updates before refreshing the managed desktop", async () => {
  const f = fixture();
  await maintainBeforeLaunch(true, f.services);
  assert.deepEqual(f.calls, ["update", "repair:false"]);
});

test("opening an already-running desktop does not update or repair it", async () => {
  const f = fixture();
  f.services.isRunning = () => true;
  await maintainBeforeLaunch(true, f.services);
  assert.deepEqual(f.calls, []);
});

test("successful update hands launch to the new package without repairing through the old package", async () => {
  const f = fixture();
  f.services.update = async () => "/new-package";
  assert.equal(await maintainBeforeLaunch(true, f.services), "/new-package");
  assert.deepEqual(f.calls, []);
});

test("the new package completes launch without checking for another update", async () => {
  const f = fixture();
  f.state.version = "0.0.1";
  await maintainBeforeLaunch(false, f.services);
  assert.deepEqual(f.calls, ["repair:true"]);
});

test("download failure is reported and still allows the installed copy to be prepared", async () => {
  const f = fixture();
  f.services.update = async () => { throw new Error("offline"); };
  await maintainBeforeLaunch(true, f.services);
  assert.deepEqual(f.calls, ["report:Error: offline", "repair:false"]);
});

test("failed recovery stops launch instead of opening an uncertain installation", async () => {
  const f = fixture();
  f.services.update = async () => { throw new UpdateRecoveryError("needs repair"); };
  await assert.rejects(maintainBeforeLaunch(true, f.services), /needs repair/);
  assert.deepEqual(f.calls, []);
});
