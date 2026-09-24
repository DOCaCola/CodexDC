import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("install publishes the Windows launcher only after a successful patch", () => {
  const source = readFileSync(
    new URL("../src/commands/install.ts", import.meta.url),
    "utf8",
  );
  const stateWrite = source.indexOf("writeState(paths.stateFile");
  const launcherInstall = source.indexOf(
    "const launcher = installWindowsManagedAppLauncher(codex)",
  );
  const mirrorPrune = source.indexOf(
    "const mirrorRetention = pruneWindowsStoreMirrors(codex.appRoot)",
  );

  assert.notEqual(stateWrite, -1);
  assert.notEqual(launcherInstall, -1);
  assert.notEqual(mirrorPrune, -1);
  assert.ok(stateWrite < launcherInstall);
  assert.ok(launcherInstall < mirrorPrune);
});

test("repair preserves working mirrors until the replacement install succeeds", () => {
  const source = readFileSync(
    new URL("../src/commands/repair.ts", import.meta.url),
    "utf8",
  );
  const installAttempt = source.indexOf("await install({");
  const failureHandler = source.indexOf("} catch (error) {");
  const failedMirrorRemoval = source.indexOf(
    "removeWindowsStoreMirror(targetAppRoot)",
  );

  assert.notEqual(installAttempt, -1);
  assert.notEqual(failureHandler, -1);
  assert.notEqual(failedMirrorRemoval, -1);
  assert.ok(installAttempt < failureHandler);
  assert.ok(failureHandler < failedMirrorRemoval);
  assert.doesNotMatch(source, /pruneWindowsStoreMirrors/);
});

test("repair does not accept a patched ASAR with stale host integrity metadata", () => {
  const source = readFileSync(
    new URL("../src/commands/repair.ts", import.meta.url),
    "utf8",
  );
  const integrityRead = source.indexOf("const hostIntegrity = getIntegrity(codex)");
  const mismatchCheck = source.indexOf("const hostIntegrityMismatch");
  const intactCheck = source.indexOf(
    "headerHash === state.patchedAsarHash && !hostIntegrityMismatch",
  );

  assert.notEqual(integrityRead, -1);
  assert.notEqual(mismatchCheck, -1);
  assert.notEqual(intactCheck, -1);
  assert.ok(integrityRead < mismatchCheck);
  assert.ok(mismatchCheck < intactCheck);
});
