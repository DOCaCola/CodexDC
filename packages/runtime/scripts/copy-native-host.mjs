import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const repoRoot = resolve(runtimeRoot, "..", "..");
const src = resolve(repoRoot, "packages/native-host/dist/codexpp_native_host.node");
const outDir = resolve(runtimeRoot, "dist/native");
const out = resolve(outDir, "codexpp_native_host.node");

rmSync(outDir, { recursive: true, force: true });
if (process.platform !== "darwin") {
  process.exit(0);
}
if (!existsSync(src)) throw new Error("Required macOS native host build is missing");

mkdirSync(outDir, { recursive: true });
cpSync(src, out);
console.log(`[runtime] native host -> ${out}`);
