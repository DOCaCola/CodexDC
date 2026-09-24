import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import * as tar from "tar";

export interface ReleaseAsset { name: string; browser_download_url: string; digest?: string; size: number }
export interface Release { id: number; tag_name: string; html_url: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

export async function latestRelease(repo: string): Promise<Release> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "CodexDC" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) throw new Error(`No published stable release is available for ${repo}.`);
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status}). Try again later.`);
  const release = await response.json() as Release;
  if (release.draft || release.prerelease || !Number.isSafeInteger(release.id) || !Array.isArray(release.assets)) {
    throw new Error("Invalid stable release metadata");
  }
  return release;
}

export function releaseAsset(release: Release, name: string): ReleaseAsset {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) throw new Error(`Release ${release.tag_name} has no unique ${name} package.`);
  return matches[0];
}

export async function downloadReleaseAsset(repo: string, asset: ReleaseAsset): Promise<Buffer> {
  if (!asset.browser_download_url.startsWith(`https://github.com/${repo}/releases/download/`)) {
    throw new Error("Release asset is outside the configured repository");
  }
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${asset.name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size) throw new Error(`Incomplete download: ${asset.name}`);
  return bytes;
}

export function expectedChecksum(sums: string, name: string): string {
  const matches = sums.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line))
    .filter((line) => line?.[2] === name);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous checksum for ${name}`);
  return matches[0]![1].toLowerCase();
}

export function verifyChecksum(bytes: Buffer, expected: string): void {
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Release checksum mismatch");
}

export function containedArchivePath(root: string, name: string): string {
  // Reject Windows paths on every platform as well as POSIX traversal.
  if (name.includes("\\") || name.includes(":") || name.includes("\0") || name.startsWith("/") ||
      name.split("/").some((part) => part === "..")) throw new Error(`Unsafe archive path: ${name}`);
  const target = resolve(root, name);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Unsafe archive path: ${name}`);
  return target;
}

export async function extractPackage(archive: string, root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  if (archive.endsWith(".zip")) {
    await new Promise<void>((resolveDone, reject) => {
      yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
        if (error || !zip) return reject(error ?? new Error("Cannot open ZIP"));
        const seen = new Set<string>();
        zip.on("error", reject);
        zip.on("end", resolveDone);
        zip.on("entry", (entry: yauzl.Entry) => {
          void (async () => {
            const target = containedArchivePath(root, entry.fileName);
            const key = target.toLowerCase();
            if (seen.has(key)) throw new Error(`Duplicate archive entry: ${entry.fileName}`);
            seen.add(key);
            if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error("ZIP links are not allowed");
            if (entry.fileName.endsWith("/")) mkdirSync(target, { recursive: true });
            else {
              mkdirSync(dirname(target), { recursive: true });
              const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
                zip.openReadStream(entry, (err, input) => err || !input ? rej(err) : res(input)));
              await pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o755 }));
            }
            zip.readEntry();
          })().catch((err) => { zip.close(); reject(err); });
        });
        zip.readEntry();
      });
    });
    return;
  }
  // Validate the whole archive before creating any entries.
  let invalid: Error | undefined;
  const seen = new Set<string>();
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    try {
      const key = containedArchivePath(root, entry.path).toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate archive entry: ${entry.path}`);
      seen.add(key);
      if (!["File", "Directory"].includes(entry.type)) throw new Error(`Unsupported archive entry: ${entry.type}`);
    } catch (error) { invalid ??= error as Error; }
  } });
  if (invalid) throw invalid;
  await tar.x({ file: archive, cwd: root, strict: true, preservePaths: false, noChmod: false });
}
