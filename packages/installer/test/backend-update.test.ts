import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backendState, rollbackBackend, setBackendAutoUpdate, type BackendState } from "../src/backend";
import { updateBackendBeforeLaunch } from "../src/backend-update";
import type { Release } from "../src/releases";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexdc-backend-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "codex");
  writeFileSync(executable, "fixture");
  const initial: BackendState = { provider: "fork", autoUpdate: true,
    installed: { executable, tag: "doca-v0.157.0-doca", version: "old", releaseId: 1, digest: "old" } };
  const save = (state: BackendState) => writeFileSync(join(root, "backend.json"), JSON.stringify(state));
  save(initial);
  let checks = 0, installs = 0;
  const reports: string[] = [];
  const release: Release = { id: 2, tag_name: "doca-v0.157.1-doca", html_url: "", draft: false, prerelease: false, assets: [] };
  const services = {
    latestRelease: async () => { checks++; return release; },
    installBackend: async (_root: string, candidate?: Release) => {
      assert.equal(candidate, release);
      installs++;
      const state = { ...backendState(root), previous: initial.installed,
        installed: { ...initial.installed!, releaseId: 2, tag: release.tag_name } };
      save(state);
      return state;
    },
    now: () => Date.UTC(2026, 8, 26),
    report: (message: string) => { reports.push(message); },
  };
  return { root, initial, save, services, release, reports, counts: () => [checks, installs] };
}

test("opted-in updates use one release, retain rollback, and throttle checks", async (t) => {
  const f = fixture(t);
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [1, 1]);
  assert.deepEqual(backendState(f.root).previous, f.initial.installed);
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [1, 1]);
  rollbackBackend(f.root);
  assert.equal(backendState(f.root).autoUpdate, false);
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [1, 1]);
});

test("bundled, development and disabled selections never check releases", async (t) => {
  const f = fixture(t);
  for (const provider of ["bundled", "development"] as const) {
    f.save({ ...f.initial, provider });
    await updateBackendBeforeLaunch(f.root, f.services);
  }
  f.save({ ...f.initial, autoUpdate: undefined });
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [0, 0]);
});

test("failed validation preserves the installed backend and reports the failure", async (t) => {
  const f = fixture(t);
  f.services.installBackend = async () => { throw new Error("probe failed"); };
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(backendState(f.root).installed, f.initial.installed);
  assert.match(backendState(f.root).updateCheck!.error!, /probe failed/);
  assert.equal(f.reports.length, 1);
  setBackendAutoUpdate(true, f.root);
  assert.equal(backendState(f.root).updateCheck, undefined);
});

test("an unchanged release does not download or replace the rollback package", async (t) => {
  const f = fixture(t);
  f.release.id = 1;
  f.release.tag_name = f.initial.installed!.tag;
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [1, 0]);
  assert.equal(backendState(f.root).previous, undefined);
});

test("older latest releases are not installed; fork patch revisions update", async (t) => {
  const f = fixture(t);
  f.release.tag_name = "doca-v0.156.1-doca";
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [1, 0]);
  setBackendAutoUpdate(true, f.root);
  f.release.tag_name = "doca-v0.157.0-doca.1";
  await updateBackendBeforeLaunch(f.root, f.services);
  assert.deepEqual(f.counts(), [2, 1]);
});
