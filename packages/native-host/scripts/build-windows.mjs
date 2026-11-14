import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "packages/native-host/dist");
mkdirSync(out, { recursive: true });
if (process.arch !== "x64") throw new Error("The Windows restart bridge currently requires x64.");

const version = "24.13.0";
const cache = join(root, ".cache/node-headers");
const nodeRoot = join(cache, `node-v${version}`);
if (!existsSync(join(nodeRoot, "include/node/node_api.h"))) {
  mkdirSync(cache, { recursive: true });
  const name = `node-v${version}-headers.tar.gz`;
  const base = `https://nodejs.org/dist/v${version}/`;
  const [sums, archive] = await Promise.all([download(base + "SHASUMS256.txt"), download(base + name)]);
  const digest = sums.toString().split("\n").find(line => line.endsWith(`  ${name}`))?.slice(0, 64);
  if (!digest || createHash("sha256").update(archive).digest("hex") !== digest) throw new Error("Node header checksum mismatch.");
  const file = join(cache, name);
  writeFileSync(file, archive);
  execFileSync(join(process.env.SystemRoot, "System32/tar.exe"), ["-xf", file, "-C", cache]);
}

const vswhere = join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio/Installer/vswhere.exe");
const vs = execFileSync(vswhere, ["-latest", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
  { encoding: "utf8" }).trim();
if (!vs) throw new Error("Install the Visual Studio C++ x64 build tools.");
const vc = join(vs, "VC/Tools/MSVC", latest(join(vs, "VC/Tools/MSVC")));
const kits = join(process.env["ProgramFiles(x86)"], "Windows Kits/10");
const sdk = latest(join(kits, "Include"));
const env = {
  ...process.env,
  INCLUDE: [join(nodeRoot, "include/node"), join(vc, "include"), ...["ucrt", "shared", "um"].map(part => join(kits, "Include", sdk, part))].join(";"),
  LIB: [join(vc, "lib/x64"), ...["ucrt", "um"].map(part => join(kits, "Lib", sdk, part, "x64"))].join(";"),
  PATH: `${join(vc, "bin/Hostx64/x64")};${process.env.PATH}`,
};
execFileSync(join(vc, "bin/Hostx64/x64/cl.exe"), [
  "/nologo", "/LD", "/O2", "/MT", "/W4", "/DNAPI_VERSION=8",
  `/Fo${join(out, "windows_restart.obj")}`,
  join(root, "packages/native-host/src/windows_restart.c"),
  "/link", "/Brepro", `/OUT:${join(out, "codexdc_windows_restart.node")}`, `/IMPLIB:${join(out, "windows_restart.lib")}`,
], { env, cwd: out, stdio: "inherit" });
console.log("[native-host] built Windows restart bridge");

function latest(dir) {
  const result = readdirSync(dir).filter(name => /^\d+(\.\d+)+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  if (!result) throw new Error(`No SDK/toolset version found in ${dir}`);
  return result;
}
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
