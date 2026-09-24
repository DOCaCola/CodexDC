import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_PLUS_PLUS_WINDOWS_APP_USER_MODEL_ID,
  inferWindowsAppUserModelId,
} from "../src/windows-app-identity";

test("infers the CodexDC AppUserModelId from a CodexDC mirror path", () => {
  assert.equal(
    inferWindowsAppUserModelId(
      "C:\\Users\\user\\AppData\\Local\\codexdc\\store-apps\\OpenAI.Codex_26.707.3748.0_x64__2p2nqsd0c76g0\\app\\resources",
    ),
    CODEX_PLUS_PLUS_WINDOWS_APP_USER_MODEL_ID,
  );
});

test("does not assign an identity to an unrelated executable path", () => {
  assert.equal(
    inferWindowsAppUserModelId("C:\\Program Files\\Codex\\resources"),
    null,
  );
});
