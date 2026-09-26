import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as tar from "tar";
import test from "node:test";
import { backendState, installBackend } from "../src/backend";
import type { Release, ReleaseAsset } from "../src/releases";

test("macOS release archive installs as a complete backend; a rejected update retains it", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "codexdc-mac-package-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, "source"), root = join(work, "user");
  const files = ["bin/codex", "bin/hpatch", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/zsh/bin/zsh"];
  for (const file of files) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), "fixture", { mode: 0o755 });
  }
  writeFileSync(join(source, "codex-package.json"), JSON.stringify({
    layoutVersion: 1, target: "aarch64-apple-darwin", entrypoint: "bin/codex",
    resourcesDir: "codex-resources", pathDir: "codex-path",
  }));
  const name = "codex-doca-aarch64-apple-darwin.tar.gz";
  await tar.c({ file: join(work, name), cwd: source, gzip: true }, ["bin", "codex-path", "codex-resources", "codex-package.json"]);
  const bytes = readFileSync(join(work, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const release: Release = { id: 1, tag_name: "doca-v0.157.1-doca", html_url: "", draft: false, prerelease: false,
    assets: [name, "SHA256SUMS"].map((name) => ({ name, size: 0, browser_download_url: "" })) };
  const services = {
    platform: "darwin" as const, arch: "arm64",
    latestRelease: async () => release,
    downloadReleaseAsset: async (_repo: string, asset: ReleaseAsset) =>
      asset.name === name ? bytes : Buffer.from(`${digest}  ${name}\n`),
    probeBackend: async (executable: string) => {
      for (const file of files) assert.ok(existsSync(join(dirname(dirname(executable)), file)));
      return "codex-cli 0.157.1-doca";
    },
  };
  const installed = await installBackend(root, undefined, services);
  assert.match(installed.installed!.executable, /darwin-arm64/);
  assert.equal(installed.installed!.digest, digest);
  assert.ok(existsSync(installed.installed!.executable));
  release.id = 2;
  services.probeBackend = async () => { throw new Error("app-server rejected initialization"); };
  await assert.rejects(installBackend(root, undefined, services), /rejected initialization/);
  assert.deepEqual(backendState(root), installed);
  assert.equal(existsSync(join(root, "backend-install.lock")), false);
});
