import assert from "node:assert/strict";
import { type ChildProcess, type spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { launchWindowsDesktop } from "../src/windows-desktop-launch.js";

for (const args of [[], ["--example", "a b"], ["--do-not-de-elevate", "--example"]]) {
  test(`Windows desktop preserves the caller's token with arguments ${JSON.stringify(args)}`, () => {
    const executable = join("managed app", "ChatGPT.exe");
    const env = { CODEX_CLI_PATH: "custom backend", CODEXDC_APP_USER_MODEL_ID: "DOCaCola.CodexDC" };
    const originalArgs = [...args];
    const child = {} as ChildProcess;
    const spawnDesktop = ((file: string, launchArgs: string[], options: object) => {
      assert.equal(file, executable);
      assert.equal(launchArgs.filter(arg => arg === "--do-not-de-elevate").length, 1);
      assert.deepEqual(launchArgs.filter(arg => arg !== "--do-not-de-elevate"),
        args.filter(arg => arg !== "--do-not-de-elevate"));
      assert.deepEqual(options, { env, cwd: dirname(executable), detached: true, stdio: "ignore" });
      return child;
    }) as typeof spawn;
    assert.equal(launchWindowsDesktop(executable, args, env, spawnDesktop), child);
    assert.deepEqual(args, originalArgs);
  });
}
