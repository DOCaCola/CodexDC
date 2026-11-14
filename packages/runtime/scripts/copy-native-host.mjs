import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const repoRoot = resolve(runtimeRoot, "..", "..");
const name = process.platform === "win32" ? "codexdc_windows_restart.node" : "codexpp_native_host.node";
const src = resolve(repoRoot, "packages/native-host/dist", name);
const outDir = resolve(runtimeRoot, "dist/native");
const out = resolve(outDir, name);

rmSync(outDir, { recursive: true, force: true });
if (!["darwin", "win32"].includes(process.platform)) {
  process.exit(0);
}
if (!existsSync(src)) throw new Error(`Required native host build is missing: ${name}`);

mkdirSync(outDir, { recursive: true });
cpSync(src, out);
console.log(`[runtime] native host -> ${out}`);
