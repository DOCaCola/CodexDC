import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const version = "24.13.0";
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
const target = `${process.platform}-${process.arch}`;
if (!["win32-x64", "darwin-arm64"].includes(target)) throw new Error(`Unsupported package target ${target}`);
const nodeTarget = process.platform === "win32" ? "win-x64" : "darwin-arm64";
const archiveName = `node-v${version}-${nodeTarget}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
const cache = resolve(".cache/node");
const nodeRoot = join(cache, `node-v${version}-${nodeTarget}`);
mkdirSync(cache, { recursive: true });
if (!existsSync(nodeRoot)) {
  const base = `https://nodejs.org/dist/v${version}/`;
  const sumsResponse = await fetch(base + "SHASUMS256.txt");
  if (!sumsResponse.ok) throw new Error("Cannot fetch Node checksums");
  const sums = await sumsResponse.text();
  const line = sums.split("\n").find((line) => line.endsWith(`  ${archiveName}`));
  if (!line) throw new Error("Node checksum missing");
  const response = await fetch(base + archiveName);
  if (!response.ok) throw new Error("Cannot download bundled Node");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== line.slice(0, 64)) throw new Error("Node checksum mismatch");
  const archive = join(cache, archiveName);
  writeFileSync(archive, bytes);
  execFileSync(tar, ["-xf", archive, "-C", cache], { stdio: "inherit" });
}
// The same pinned headers can be used for native builds in CI.
if (process.argv.includes("--node-only")) {
  console.log(nodeRoot);
  process.exit(0);
}
const stage = resolve("dist/package");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const name of ["package.json", "package-lock.json", "LICENSE", "NOTICE.md", "README.md"]) cpSync(name, join(stage, name));
writeFileSync(join(stage, "codexdc-release.json"), JSON.stringify({ version: JSON.parse(readFileSync("package.json")).version, target, nodeVersion: version }));
for (const name of readdirSync("packages")) {
  mkdirSync(join(stage, "packages", name), { recursive: true });
  cpSync(join("packages", name, "package.json"), join(stage, "packages", name, "package.json"));
}
for (const path of ["packages/installer/dist", "packages/installer/assets", "packages/sdk/dist"]) {
  cpSync(path, join(stage, path), { recursive: true });
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run packaging with npm run package");
execFileSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
// Executable npm shims are unnecessary: maintenance calls JavaScript with bundled Node.
// Removing them also keeps tar packages free of npm's POSIX symlinks.
function removeBinDirectories(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.name === ".bin") rmSync(path, { recursive: true, force: true });
    else removeBinDirectories(path);
  }
}
removeBinDirectories(join(stage, "node_modules"));
// Materialize workspace links so archive extraction needs no symlink support.
for (const name of readdirSync("packages")) {
  const pkg = JSON.parse(readFileSync(join("packages", name, "package.json")));
  const targetPath = join(stage, "node_modules", ...pkg.name.split("/"));
  rmSync(targetPath, { recursive: true, force: true });
  cpSync(join(stage, "packages", name), targetPath, { recursive: true });
}
mkdirSync(join(stage, "node"), { recursive: true });
const nodeExe = process.platform === "win32" ? "node.exe" : "bin/node";
cpSync(join(nodeRoot, nodeExe), join(stage, "node", process.platform === "win32" ? "node.exe" : "node"));
cpSync(join(nodeRoot, "LICENSE"), join(stage, "node", "LICENSE"));
if (process.platform === "win32") {
  writeFileSync(join(stage, "Setup.cmd"), '@echo off\r\ncd /d "%~dp0"\r\n"%~dp0node\\node.exe" "%~dp0packages\\installer\\dist\\cli.js" setup\r\n');
} else {
  writeFileSync(join(stage, "Setup.command"), '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./node/node ./packages/installer/dist/cli.js setup\n', { mode: 0o755 });
}
const packagedNode = join(stage, "node", process.platform === "win32" ? "node.exe" : "node");
execFileSync(packagedNode, [join(stage, "packages/installer/dist/cli.js"), "--help"], { cwd: cache, stdio: "inherit" });
const output = resolve("dist", `CodexDC-${target}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
rmSync(output, { force: true });
execFileSync(tar, process.platform === "win32" ? ["-a", "-cf", output, "-C", stage, "."] : ["-czf", output, "-C", stage, "."], { stdio: "inherit" });
writeFileSync(resolve("dist/SHA256SUMS"), `${createHash("sha256").update(readFileSync(output)).digest("hex")}  ${output.split(/[\\/]/).at(-1)}\n`);
console.log(`Packaged ${output}`);
