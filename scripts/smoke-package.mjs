import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractPackage } from "../packages/installer/dist/releases.js";

const stage = mkdtempSync(join(tmpdir(), "CodexDC package with spaces "));
try {
  const archive = resolve("dist", `CodexDC-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
  await extractPackage(archive, stage);
  const node = join(stage, "node", process.platform === "win32" ? "node.exe" : "node");
  const cli = join(stage, "packages", "installer", "dist", "cli.js");
  const options = { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, CODEXDC_HOME: join(stage, "smoke-home") } };
  execFileSync(node, [cli, "--help"], options);
  assert.deepEqual(JSON.parse(execFileSync(node, [cli, "backend", "status"], options)), { provider: "bundled" });
  console.log("Extracted package: bundled Node, CLI and default backend passed from unrelated cwd.");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
