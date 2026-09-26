import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { probeBackend } from "../src/backend";

test("CLI probe uses an isolated data-root home and cleans it after success or rejection", async () => {
  const work = mkdtempSync(join(tmpdir(), "codexdc-probe-test-"));
  const cwd = process.cwd();
  const root = join(work, "CodexDC data");
  const capture = join(work, "probe-home.json");
  mkdirSync(root);
  try {
    process.chdir(work);
    // Node's --version and a tiny app-server fixture exercise real child
    // processes on Windows and macOS without requiring a downloaded CLI.
    for (const accepted of [true, false]) {
      writeFileSync(join(work, "app-server"), `
        const fs = require("node:fs");
        fs.writeFileSync("probe-home.json", JSON.stringify(process.env.CODEX_HOME));
        process.stdin.once("data", () => {
          console.log(JSON.stringify(${accepted
            ? '{ id: 1, result: { userAgent: "probe fixture" } }'
            : '{ id: 1, error: { message: "fixture rejection" } }'}));
        });
      `);
      if (accepted) assert.equal(await probeBackend(process.execPath, root), process.version);
      else await assert.rejects(probeBackend(process.execPath, root), /rejected initialization/);
      const home = JSON.parse(readFileSync(capture, "utf8")) as string;
      assert.match(relative(join(root, "cli-probes"), home), /^probe-[^\\/]+$/);
      assert.equal(existsSync(home), false);
      assert.deepEqual(readdirSync(join(root, "cli-probes")), []);
    }
  } finally {
    process.chdir(cwd);
    rmSync(work, { recursive: true, force: true });
  }
});
