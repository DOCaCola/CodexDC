import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsManagedCleanupScript,
  WINDOWS_CODEX_CONTEXT_MENU_KEYS,
} from "../src/windows-cleanup";

test("Windows cleanup removes only CodexDC managed context menu entries", () => {
  const script = buildWindowsManagedCleanupScript({
    localAppData: "C:\\Users\\Admin\\AppData\\Local",
    appData: "C:\\Users\\Admin\\AppData\\Roaming",
    home: "C:\\Users\\Admin",
  });

  assert.match(script, /OpenProjectInCodex/);
  assert.match(script, /GetValue\(''\)/);
  assert.match(script, /\\codex-dc\\store-apps\\/);
  assert.match(script, /Remove-Item -LiteralPath \$key -Recurse -Force/);
  assert.match(script, /codexdc-codex\.cmd/);
  assert.match(script, /CodexDC\.lnk/);
  assert.match(script, /store-apps/);
  for (const key of WINDOWS_CODEX_CONTEXT_MENU_KEYS) {
    assert.match(script, new RegExp(key.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  }
});
