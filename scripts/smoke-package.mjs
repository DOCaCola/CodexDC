import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(options.env.CODEXDC_HOME, { recursive: true });
  execFileSync(node, [cli, "--help"], options);
  assert.deepEqual(JSON.parse(execFileSync(node, [cli, "backend", "status"], options)), { provider: "bundled" });
  // Setup shortcuts retain their original command after updates. Exercise that
  // old entry point across two activations using real child processes.
  for (const version of ["next", "newest"]) {
    const active = join(stage, version);
    mkdirSync(join(active, "node"), { recursive: true });
    mkdirSync(join(active, "packages", "installer", "dist"), { recursive: true });
    linkSync(node, join(active, "node", process.platform === "win32" ? "node.exe" : "node"));
    writeFileSync(join(active, "packages", "installer", "dist", "cli.js"),
      `console.log(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), cwd: process.cwd(), desktopArgs: process.env.CODEXDC_DESKTOP_ARGS }));`);
    writeFileSync(join(options.env.CODEXDC_HOME, "maintenance-selection.json"), JSON.stringify({ active, previous: stage }));
    const result = JSON.parse(execFileSync(node, [cli, "launch"], {
      ...options,
    }));
    assert.deepEqual(result, { version, args: ["launch"], cwd: realpathSync(active) });
    const desktopArgs = ["C:\\Project with spaces", "--example"];
    const shortcutResult = JSON.parse(execFileSync(node, [
      join(stage, "packages", "installer", "dist", "desktop-launch.js"), ...desktopArgs,
    ], options));
    assert.deepEqual(shortcutResult, {
      version, args: ["launch"], cwd: realpathSync(active), desktopArgs: JSON.stringify(desktopArgs),
    });
  }
  const candidate = JSON.parse(execFileSync(node, [cli, "backend", "status"], {
    ...options, env: { ...options.env, CODEXDC_ACTIVATING: "1" },
  }));
  assert.deepEqual(candidate, { provider: "bundled" });
  console.log("Extracted package passed: bundled runtime, repeated launch forwarding, and candidate activation bypass.");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
