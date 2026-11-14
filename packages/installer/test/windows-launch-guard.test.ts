import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLaunchConflicts, guardWindowsLaunch, type DesktopProcess } from "../src/windows-launch-guard.js";
import type { InstallerState } from "../src/state.js";

const expected = { executable: "C:\\Managed\\ChatGPT.exe", backend: "D:\\fork\\bin\\codex.exe", runtimeHash: "current" };
const desktop: DesktopProcess = {
  pid: 10, parentPid: 1, executable: expected.executable, commandLine: '"C:\\Managed\\ChatGPT.exe" --restart',
  startedAt: "2026-11-14T09:17:55Z", name: "ChatGPT.exe",
};
const server: DesktopProcess = {
  pid: 11, parentPid: 10, executable: expected.backend, commandLine: '"D:\\fork\\bin\\codex.exe" app-server',
  startedAt: "2026-11-14T09:18:00Z", name: "codex.exe",
};
const loaded = {
  pid: 10, executable: desktop.executable, reportedAt: "2026-11-14T09:17:56Z", runtimeHash: "current",
};

test("a verified managed instance with the selected backend is reused", () => {
  assert.deepEqual(findLaunchConflicts([desktop, server], expected, () => loaded), []);
  assert.deepEqual(findLaunchConflicts([desktop, { ...server, executable: "d:/FORK/bin/CODEX.exe" }], expected, () => loaded), []);
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
      inspect: () => processes,
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
