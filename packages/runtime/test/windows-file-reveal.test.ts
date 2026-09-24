import assert from "node:assert/strict";
import test from "node:test";
import {
  installWindowsFileRevealOverride,
  resolveDirectoryOpusRuntime,
} from "../src/windows-file-reveal";

const DOPUSRT = "C:\\Program Files\\GPSoftware\\Directory Opus\\dopusrt.exe";

test("resolveDirectoryOpusRuntime finds the standard 64-bit install", () => {
  assert.equal(
    resolveDirectoryOpusRuntime(
      { ProgramW6432: "C:\\Program Files" },
      (path) => path === DOPUSRT,
    ),
    DOPUSRT,
  );
});

test("Windows file reveal uses Directory Opus to select files", () => {
  const shell = { showItemInFolder() {}, async openPath() { return ""; } };
  let launch: { executable: string; args: string[] } | null = null;
  let unrefCalled = false;
  const result = installWindowsFileRevealOverride({
    shell,
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: (path) => path === DOPUSRT,
    pathStat: () => ({ isDirectory: () => false }),
    spawn: (executable, args) => {
      launch = { executable, args };
      return { unref: () => { unrefCalled = true; } };
    },
  });

  shell.showItemInFolder("C:\\tmp\\image.png");

  assert.deepEqual(result, { installed: true, directoryOpusRuntime: DOPUSRT });
  assert.deepEqual(launch, {
    executable: DOPUSRT,
    args: ["/acmd", "Go", "C:\\tmp\\image.png", "OPENCONTAINER", "TOFRONT"],
  });
  assert.equal(unrefCalled, true);
});

test("Windows file reveal opens directories without OPENCONTAINER", () => {
  const shell = { showItemInFolder() {}, async openPath() { return ""; } };
  let args: string[] | null = null;
  installWindowsFileRevealOverride({
    shell,
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: (path) => path === DOPUSRT,
    pathStat: () => ({ isDirectory: () => true }),
    spawn: (_executable, spawnArgs) => {
      args = spawnArgs;
      return {};
    },
  });

  shell.showItemInFolder("C:\\tmp");

  assert.deepEqual(args, ["/acmd", "Go", "C:\\tmp", "TOFRONT"]);
});

test("Windows openPath uses Directory Opus for directories", async () => {
  let stockOpenPathCalls = 0;
  const shell = {
    showItemInFolder() {},
    async openPath() {
      stockOpenPathCalls += 1;
      return "stock-error";
    },
  };
  let args: string[] | null = null;
  installWindowsFileRevealOverride({
    shell,
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: (path) => path === DOPUSRT,
    pathStat: () => ({ isDirectory: () => true }),
    spawn: (_executable, spawnArgs) => {
      args = spawnArgs;
      return {};
    },
  });

  const result = await shell.openPath("C:\\tmp");

  assert.equal(result, "");
  assert.equal(stockOpenPathCalls, 0);
  assert.deepEqual(args, ["/acmd", "Go", "C:\\tmp", "TOFRONT"]);
});

test("Windows openPath preserves host behavior for files", async () => {
  const stockPaths: string[] = [];
  const shell = {
    showItemInFolder() {},
    async openPath(path: string) {
      stockPaths.push(path);
      return "stock-error";
    },
  };
  installWindowsFileRevealOverride({
    shell,
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: (path) => path === DOPUSRT,
    pathStat: () => ({ isDirectory: () => false }),
    spawn: () => ({}),
  });

  const result = await shell.openPath("C:\\tmp\\image.png");

  assert.equal(result, "stock-error");
  assert.deepEqual(stockPaths, ["C:\\tmp\\image.png"]);
});

test("file reveal leaves the host unchanged when Directory Opus is unavailable", () => {
  let stockCalls = 0;
  const stockShowItemInFolder = () => { stockCalls += 1; };
  const stockOpenPath = async () => "";
  const shell = { showItemInFolder: stockShowItemInFolder, openPath: stockOpenPath };
  const result = installWindowsFileRevealOverride({
    shell,
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    pathExists: () => false,
    spawn: () => ({}),
  });

  shell.showItemInFolder("C:\\tmp\\image.png");

  assert.deepEqual(result, { installed: false, directoryOpusRuntime: null });
  assert.equal(shell.showItemInFolder, stockShowItemInFolder);
  assert.equal(shell.openPath, stockOpenPath);
  assert.equal(stockCalls, 1);
});
