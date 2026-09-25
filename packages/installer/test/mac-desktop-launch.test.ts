import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { launchMacDesktop } from "../src/mac-desktop-launch.js";

test("macOS desktop uses Launch Services with backend environment and literal arguments", () => {
  const env = { CODEX_CLI_PATH: "/custom backend/codex", API_KEY: "secret" };
  const open = ((file: string, args: string[], options: object) => {
    assert.equal(file, "/usr/bin/open");
    assert.deepEqual(args, ["-a", "/Apps/Codex DC.app", "--args", "--example", "a b"]);
    assert.deepEqual(options, { env: { ...env, CODEXDC_DESKTOP_READY: "1" }, stdio: "inherit" });
    return Buffer.alloc(0);
  }) as typeof execFileSync;
  launchMacDesktop("/Apps/Codex DC.app", ["--example", "a b"], env, open);
  assert.equal("CODEXDC_DESKTOP_READY" in env, false);
});

test("Launch Services failures propagate instead of reporting a successful launch", () => {
  const failure = new Error("Launch Services rejected app");
  const open = (() => { throw failure; }) as typeof execFileSync;
  assert.throws(() => launchMacDesktop("/app", [], {}, open), (error) => error === failure);
});
