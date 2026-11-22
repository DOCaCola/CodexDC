import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("a macOS launch blocked by disk space logs the error and alerts Dock users", { skip: process.platform !== "darwin" }, () => {
  const profile = mkdtempSync(join(tmpdir(), "codexdc-launch-alert-"));
  try {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const injectFailure = `
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";

      const mkdir = fs.mkdirSync;
      fs.mkdirSync = (dir, options) => {
        if (dir === process.env.CODEXDC_HOME) {
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return mkdir(dir, options);
      };
      const execFile = childProcess.execFileSync;
      childProcess.execFileSync = (file, args, options) => {
        if (file !== "osascript") return execFile(file, args, options);
        console.log(JSON.stringify({
          title: options.env.CODEXPP_ALERT_TITLE,
          message: options.env.CODEXPP_ALERT_MESSAGE,
        }));
        return "button returned:OK";
      };
      syncBuiltinESMExports();
    `;
    const args = ["--import", `data:text/javascript,${encodeURIComponent(injectFailure)}`, cli, "launch"];
    const env = { ...process.env, CODEXDC_HOME: profile };
    delete env.CODEXDC_LAUNCH_PARENT;
    const terminal = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(terminal.status, 1, terminal.stderr);
    assert.match(terminal.stderr, /ENOSPC/);
    assert.doesNotMatch(terminal.stdout, /could not start/);

    const dock = spawnSync(process.execPath, args, {
      env: { ...env, CODEXDC_LAUNCH_PARENT: "2147483647" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(dock.status, 1, dock.stderr);
    assert.match(dock.stderr, /ENOSPC/);
    const alert = JSON.parse(dock.stdout.trim().split("\n").at(-1)!);
    assert.equal(alert.title, "CodexDC could not start");
    assert.match(alert.message, /not enough free disk space/);
    assert.ok(alert.message.includes(join(profile, "log", "launch.log")));
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
