import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

test("Windows addon loads in Node and clears a real registration in a disposable host", { skip: process.platform !== "win32" }, () => {
  const library = resolve("packages/native-host/dist/codexdc_windows_restart.node");
  const host = createRequire(import.meta.url)(library);
  host.unregisterRestart();
  assert.equal(host.getRestartRegistration(), null);
  const output = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    resolve("packages/native-host/test/windows-restart-native.ps1"), "-Library", library,
  ], { encoding: "utf8", timeout: 20_000 });
  assert.match(output, /test passed/);
});
