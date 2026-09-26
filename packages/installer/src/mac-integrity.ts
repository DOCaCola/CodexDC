import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
type Dictionary = Record<string, { algorithm: string; hash: string }>;

/** Native ASAR dictionary digest v1: sorted paths followed by algorithm and hash. */
export function macIntegrityDigest(dictionary: Dictionary): Buffer {
  const hash = createHash("sha256");
  for (const path of Object.keys(dictionary).sort()) {
    const entry = dictionary[path]!;
    hash.update(path).update(entry.algorithm).update(entry.hash);
  }
  return hash.digest();
}
export function macIntegrityDigestOffset(binary: Buffer): number | null {
  const offset = binary.indexOf(SENTINEL);
  if (offset < 0) return null;
  if (binary.indexOf(SENTINEL, offset + SENTINEL.length) !== -1 || offset + 66 > binary.length) throw new Error("Invalid native ASAR integrity digest slot.");
  if (binary[offset + 32] === 0) return null;
  if (binary[offset + 32] !== 1 || binary[offset + 33] !== 1) throw new Error("Unsupported native ASAR integrity digest version.");
  return offset + 34;
}
export function prepareMacIntegrityDigest(appRoot: string, dictionary: Dictionary) {
  const framework = join(appRoot, "Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework");
  if (!existsSync(framework)) return null;
  const binary = readFileSync(framework);
  const offset = macIntegrityDigestOffset(binary);
  if (offset === null) return null;
  if (!binary.subarray(offset, offset + 32).equals(macIntegrityDigest(dictionary))) {
    throw new Error("Native framework ASAR dictionary digest does not match Info.plist. Run repair --force.");
  }
  return (updated: Dictionary) => {
    const fd = openSync(framework, "r+");
    try {
      if (writeSync(fd, macIntegrityDigest(updated), 0, 32, offset) !== 32) throw new Error("Incomplete native ASAR integrity digest write.");
    } finally { closeSync(fd); }
  };
}
