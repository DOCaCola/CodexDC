import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findLaunchConflicts, guardWindowsLaunch, type DesktopProcess } from "../src/windows-launch-guard.js";
import type { InstallerState } from "../src/state.js";
import { desktopFingerprint } from "@codexdc/sdk/dist/desktop-fingerprint.js";

const expected = { executable: "C:\\Managed\\ChatGPT.exe", backend: "D:\\fork\\bin\\codex.exe", runtimeHash: "current", launcherElevated: false };
const desktop: DesktopProcess = {
  pid: 10, parentPid: 1, executable: expected.executable, commandLine: '"C:\\Managed\\ChatGPT.exe" --restart',
  startedAt: "2026-11-14T09:17:55Z", name: "ChatGPT.exe", elevated: null,
};
const server: DesktopProcess = {
  pid: 11, parentPid: 10, executable: expected.backend, commandLine: '"D:\\fork\\bin\\codex.exe" app-server',
  startedAt: "2026-11-14T09:18:00Z", name: "codex.exe", elevated: false,
};
const loaded = {
  pid: 10, executable: desktop.executable, reportedAt: "2026-11-14T09:17:56Z", runtimeHash: "current",
};

test("a verified managed instance with the selected backend is reused", () => {
  assert.deepEqual(findLaunchConflicts([desktop, server], expected, () => loaded), []);
  assert.deepEqual(findLaunchConflicts([desktop, { ...server, executable: "d:/FORK/bin/CODEX.exe" }], expected, () => loaded), []);
});

test("an elevated launcher checks the CLI backend token independently of the desktop token", () => {
  const elevatedLaunch = { ...expected, launcherElevated: true };
  // Desktop elevation does not establish backend elevation.
  const [conflict] = findLaunchConflicts([{ ...desktop, elevated: true }, server], elevatedLaunch, () => loaded);
  assert.equal(conflict?.process.pid, desktop.pid);
  assert.match(conflict!.reason, /CLI backend is not elevated/);
  assert.match(conflict!.reason, /start the backend as administrator/);
  assert.deepEqual(findLaunchConflicts([
    { ...desktop, elevated: false }, { ...server, elevated: true },
  ], elevatedLaunch, () => loaded), []);
  assert.deepEqual(findLaunchConflicts([desktop, { ...server, elevated: true }], expected, () => loaded), [],
    "a normal launch does not ask to downgrade an elevated backend");
});

test("an elevated launcher warns when backend elevation is unknown", () => {
  const [conflict] = findLaunchConflicts([desktop, { ...server, elevated: null }],
    { ...expected, launcherElevated: true }, () => loaded);
  assert.match(conflict!.reason, /backend elevation cannot be verified/);
  assert.deepEqual(findLaunchConflicts([desktop, { ...server, elevated: null }], expected, () => loaded), []);
});

test("other terminal or shared daemon tokens do not decide desktop backend elevation", () => {
  const extra = { ...server, pid: 30, parentPid: 1, elevated: true };
  const daemon = { ...server, pid: 31, elevated: true, commandLine: '"D:\\fork\\bin\\codex.exe" app-server --managed-daemon' };
  const [conflict] = findLaunchConflicts([desktop, server, extra, daemon],
    { ...expected, launcherElevated: true }, () => loaded);
  assert.match(conflict!.reason, /CLI backend is not elevated/);
});

test("wrong backend, unknown loaded patch, stale PID record and old runtime require a choice", () => {
  for (const [records, readLoaded] of [
    [[desktop, { ...server, executable: "C:\\Managed\\resources\\codex.exe" }], () => loaded],
    [[desktop, server], () => null],
    [[desktop, server], () => ({ ...loaded, reportedAt: "2026-11-13T09:17:56Z" })],
    [[desktop, server], () => ({ ...loaded, runtimeHash: "old" })],
    [[desktop], () => loaded],
  ] as const) {
    assert.equal(findLaunchConflicts([...records], expected, readLoaded).length, 1);
  }
});

test("official desktops are conflicts, while terminal CLIs and renderer helpers are excluded", () => {
  const official = { ...desktop, pid: 20, executable: "C:\\Official\\ChatGPT.exe" };
  const cli = { ...server, pid: 30, parentPid: 1, commandLine: '"D:\\fork\\bin\\codex.exe" --yolo' };
  const renderer = { ...desktop, pid: 12, parentPid: 10, commandLine: '"C:\\Managed\\ChatGPT.exe" --type=renderer' };
  const sandboxed = { ...renderer, pid: 13, executable: "", commandLine: "" };
  const rows = findLaunchConflicts([desktop, server, official, cli, renderer, sandboxed], expected, () => loaded,
    file => file === official.executable);
  assert.deepEqual(rows.map(row => row.process.pid), [20]);
});

test("an inaccessible desktop main process is reported instead of silently ignored", () => {
  assert.throws(() => findLaunchConflicts([{ ...desktop, executable: "" }], expected, () => loaded), /cannot be inspected/);
});

test("Cancel does not terminate anything; Kill authorizes only the displayed instances", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-guard-"));
  try {
    writeFileSync(join(root, "ChatGPT.exe"), "fixture");
    mkdirSync(join(root, "resources"));
    const state = { appRoot: root } as InstallerState;
    const running = { ...desktop, executable: join(root, "ChatGPT.exe") };
    let processes = [running];
    const killed: number[] = [];
    const deps = {
      inspect: () => ({ processes, launcherElevated: false }),
      confirm: () => false,
      kill: (conflicts: ReturnType<typeof findLaunchConflicts>) => {
        killed.push(...conflicts.map(item => item.process.pid));
        processes = [];
      },
      readLoaded: () => null,
      identifyDesktop: () => true,
    };
    assert.equal(guardWindowsLaunch(state, { provider: "bundled" }, root, deps), false);
    assert.deepEqual(killed, []);
    deps.confirm = () => true;
    assert.equal(guardWindowsLaunch(state, { provider: "bundled" }, root, deps), true);
    assert.deepEqual(killed, [10]);
    processes = [running];
    deps.kill = () => { processes = [{ ...running, pid: 50 }]; };
    assert.throws(() => guardWindowsLaunch(state, { provider: "bundled" }, root, deps), /still running/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a backend elevation mismatch uses the Cancel/Kill flow even when the runtime and backend path match", {
  skip: process.platform !== "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-elevation-"));
  try {
    const executable = join(root, "ChatGPT.exe");
    const backend = join(root, "codex.exe");
    writeFileSync(executable, "");
    writeFileSync(backend, "");
    const assets = new URL("../assets/", import.meta.url);
    const runtimeHash = desktopFingerprint(fileURLToPath(new URL("runtime/", assets)),
      readFileSync(new URL("loader.cjs", assets)));
    const running = { ...desktop, executable, elevated: true };
    const cli = { ...server, executable: backend };
    let processes = [running, cli];
    let kills = 0;
    const deps = {
      inspect: () => ({ launcherElevated: true, processes }),
      readLoaded: () => ({ ...loaded, executable, runtimeHash }),
      identifyDesktop: () => false,
      confirm: (conflicts: ReturnType<typeof findLaunchConflicts>) => {
        assert.match(conflicts[0]!.reason, /CLI backend is not elevated/);
        return false;
      },
      kill: (conflicts: ReturnType<typeof findLaunchConflicts>) => {
        assert.deepEqual(conflicts.map(item => item.process.pid), [desktop.pid]);
        kills++;
        processes = [];
      },
    };
    const state = { appRoot: root } as InstallerState;
    const selection = { provider: "development" as const, development: { executable: backend, version: "test" } };
    assert.equal(guardWindowsLaunch(state, selection, root, deps), false);
    assert.equal(kills, 0);
    deps.confirm = () => true;
    assert.equal(guardWindowsLaunch(state, selection, root, deps), true);
    assert.equal(kills, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
