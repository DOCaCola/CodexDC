import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  compareStoreVersions,
  isStorePackageReady,
  packageNameFromFamily,
  startStoreUpdate,
  waitForNewStorePackage,
} from "../src/windows-store-update";

test("Store update invokes the shipped runtime PowerShell script", (t) => {
  const family = "OpenAI.Codex_2p2nqsd0c76g0";
  const source = readFileSync(
    new URL("../../runtime/platform/windows/store-update.ps1", import.meta.url),
    "utf8",
  );
  const invocation = t.mock.method(childProcess, "execFileSync", (file, args) => {
    assert.equal(file, "powershell.exe");
    const scriptIndex = args.indexOf("-File") + 1;
    assert.ok(scriptIndex > 0);
    assert.equal(readFileSync(args[scriptIndex], "utf8"), source);
    assert.deepEqual(args.slice(scriptIndex + 1), ["start", family]);
    return '{"queued":true}';
  });
  syncBuiltinESMExports();
  try {
    assert.equal(startStoreUpdate(family), true);
    assert.equal(invocation.mock.callCount(), 1);
  } finally {
    invocation.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Store update uses package family identity and numeric versions", () => {
  assert.equal(packageNameFromFamily("OpenAI.Codex_2p2nqsd0c76g0"), "OpenAI.Codex");
  assert.throws(() => packageNameFromFamily("OpenAI.Codex'; Remove-Item"), /Invalid/);
  assert.equal(compareStoreVersions("26.917.6896.0", "26.915.4065.0"), 1);
  assert.equal(compareStoreVersions("26.915.4065.0", "26.917.6896.0"), -1);
});

test("Store package is ready only after the new package files appear", () => {
  const installed = { version: "26.917.6896.0", installLocation: "C:\\WindowsApps\\Codex" };
  assert.equal(isStorePackageReady(installed, "26.915.4065.0", () => false), false);
  assert.equal(
    isStorePackageReady(installed, "26.915.4065.0", (path) => path.endsWith("app.asar")),
    true,
  );
});

test("Store update wait ignores a registered package until its files are ready", async () => {
  const installed = { version: "26.917.6896.0", installLocation: "C:\\WindowsApps\\Codex" };
  let checks = 0;
  const progress: string[] = [];
  const result = await waitForNewStorePackage("OpenAI.Codex_publisher", "26.915.4065.0", {
    timeoutMs: 100,
    pollMs: 1,
    query: () => {
      checks += 1;
      return installed;
    },
    fileExists: () => checks > 1,
    pause: async () => {},
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result, installed);
  assert.equal(checks, 2);
  assert.match(progress[0] ?? "", /registered 26\.917\.6896\.0; waiting for app files/);
});

test("Store update wait reports the installed version while the update is pending", async () => {
  const progress: string[] = [];
  await assert.rejects(
    waitForNewStorePackage("OpenAI.Codex_publisher", "26.915.4065.0", {
      timeoutMs: 5,
      pollMs: 1,
      query: () => ({ version: "26.915.4065.0", installLocation: "C:\\WindowsApps\\Codex" }),
      pause: async () => {},
      onProgress: (message) => progress.push(message),
      progressIntervalMs: 0,
    }),
    /Timed out waiting for Windows Store/,
  );
  assert.match(progress[0] ?? "", /installed version: 26\.915\.4065\.0/);
  assert.ok(progress.length > 1, "reports again while the Store package is unchanged");
});
