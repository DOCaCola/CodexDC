import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { savedBackendEnvironment } from "../src/backend-selection";

test("direct desktop startup honors the saved backend over stale inherited paths", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-bootstrap-"));
  try {
    const executable = join(root, "codex.exe");
    writeFileSync(executable, "");
    const file = join(root, "backend.json");
    writeFileSync(file, JSON.stringify({ provider: "development", development: { executable } }));
    assert.equal(savedBackendEnvironment(root, { CODEX_CLI_PATH: "obsolete" }).CODEX_CLI_PATH, executable);
    writeFileSync(file, JSON.stringify({ provider: "bundled" }));
    assert.equal(savedBackendEnvironment(root, { CODEX_CLI_PATH: "obsolete" }).CODEX_CLI_PATH, undefined);
    writeFileSync(file, JSON.stringify({ provider: "development", development: { executable: "missing" } }));
    assert.throws(() => savedBackendEnvironment(root, {}), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
