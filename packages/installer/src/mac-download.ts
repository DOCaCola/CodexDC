import { createPublicKey, verify } from "node:crypto";
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { readPlist } from "./plist.js";
import { signatureInfo, verifySignature } from "./codesign.js";
import type { MacRelease } from "./mac-appcast.js";

export function verifyMacArchive(data: Buffer, signature: string, publicKey: string): void {
  const rawKey = Buffer.from(publicKey, "base64");
  if (rawKey.length !== 32) throw new Error("Invalid publisher update key.");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]), format: "der", type: "spki" });
  if (!verify(null, data, key, Buffer.from(signature, "base64"))) throw new Error("Publisher archive signature verification failed.");
}
export async function downloadMacRelease(release: MacRelease, publicKey: string, team: string, cache: string, progress: (percent: number) => void): Promise<string> {
  mkdirSync(cache, { recursive: true });
  const stage = mkdtempSync(join(cache, "release-"));
  const archive = join(stage, "release.zip");
  try {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(20 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Update download failed: HTTP ${response.status}`);
    let bytes = 0, lastPercent = -1;
    const count = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > release.size) { callback(new Error("Archive exceeds its declared size.")); return; }
      const percent = Math.floor(bytes / release.size * 100);
      if (percent !== lastPercent) { lastPercent = percent; progress(percent); }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(archive, { flags: "wx" }));
    if (bytes !== release.size) throw new Error("Incomplete update archive.");
    verifyMacArchive(readFileSync(archive), release.signature, publicKey);
    const extracted = join(stage, "extracted");
    await promisify(execFile)("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
    const apps = readdirSync(extracted).filter(name => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("Publisher archive must contain one app.");
    const app = join(extracted, apps[0]!);
    const info = readPlist(join(app, "Contents", "Info.plist"));
    if (info.CFBundleIdentifier !== "com.openai.codex" || String(info.CFBundleVersion) !== release.build ||
        signatureInfo(app)?.teamIdentifier !== team || !verifySignature(app).ok) {
      throw new Error("Downloaded app identity, build or publisher signature does not match.");
    }
    rmSync(archive);
    return app;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
