/**
 * Read/write the ASAR integrity metadata used by the host shell.
 *
 * macOS stores ElectronAsarIntegrity in Info.plist. Current Windows Owl builds
 * embed a compact JSON manifest in the main PE executable. The Windows value is
 * rewritten in place because the replacement SHA-256 has the same fixed width;
 * this preserves the PE layout and its surrounding resource padding.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { readPlist, writePlist } from "./plist.js";
import type { CodexInstall } from "./platform.js";

export interface IntegrityEntry {
  algorithm: "SHA256";
  hash: string;
}

export interface IntegrityUpdateResult extends IntegrityEntry {
  location: "plist" | "windows-pe";
  previousHash: string;
  changed: boolean;
}

export interface IntegrityUpdatePlan {
  entry: IntegrityEntry;
  location: IntegrityUpdateResult["location"];
  write(hash: string): IntegrityUpdateResult;
}

interface WindowsIntegrityMatch extends IntegrityEntry {
  valueOffset: number;
}

interface PeSectionRange {
  start: number;
  end: number;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;
const WINDOWS_ASAR_FILE = "resources/app.asar";
const WINDOWS_FILE_MARKER_RE =
  /"file"\s*:\s*"resources(?:\\\\|\/)app\.asar"/gi;
const WINDOWS_VALUE_RE = /"value"\s*:\s*"([0-9a-f]{64})"/i;

export function getIntegrity(install: CodexInstall): IntegrityEntry | null {
  if (install.platform === "darwin" && install.metaPath) {
    const pl = readPlist(install.metaPath);
    const block = pl["ElectronAsarIntegrity"] as
      | Record<string, IntegrityEntry>
      | undefined;
    if (!block) return null;
    return block["Resources/app.asar"] ?? null;
  }
  if (install.platform === "win32") {
    return getWindowsEmbeddedAsarIntegrity(install.executable);
  }
  return null;
}

export function setIntegrity(
  install: CodexInstall,
  hash: string,
): IntegrityUpdateResult | null {
  assertSha256(hash);
  if (install.platform === "darwin" && install.metaPath) {
    const pl = readPlist(install.metaPath);
    const existing =
      (pl["ElectronAsarIntegrity"] as Record<string, IntegrityEntry>) ?? {};
    const previousHash = existing["Resources/app.asar"]?.hash ?? hash;
    existing["Resources/app.asar"] = { algorithm: "SHA256", hash };
    pl["ElectronAsarIntegrity"] = existing;
    writePlist(install.metaPath, pl);
    return {
      algorithm: "SHA256",
      hash,
      location: "plist",
      previousHash,
      changed: previousHash !== hash,
    };
  }
  if (install.platform === "win32") {
    return setWindowsEmbeddedAsarIntegrity(install.executable, hash);
  }
  return null;
}

export function prepareIntegrityUpdate(
  install: CodexInstall,
  expectedCurrentHash: string,
  opts: { allowMismatch?: boolean } = {},
): IntegrityUpdatePlan | null {
  assertSha256(expectedCurrentHash);
  const entry = getIntegrity(install);
  if (!entry) return null;
  if (entry.hash !== expectedCurrentHash && !opts.allowMismatch) {
    throw new Error(
      `Host ASAR integrity hash does not match the current app.asar before patching: ` +
        `host=${entry.hash} asar=${expectedCurrentHash}`,
    );
  }

  const location = install.platform === "win32" ? "windows-pe" : "plist";
  return {
    entry,
    location,
    write(hash: string): IntegrityUpdateResult {
      const current = getIntegrity(install);
      if (!current || current.hash !== entry.hash) {
        throw new Error(
          "Host ASAR integrity metadata changed while CodexDC was patching the app",
        );
      }
      const result = setIntegrity(install, hash);
      if (!result) {
        throw new Error("Host ASAR integrity metadata disappeared during patching");
      }
      return result;
    },
  };
}

export function getWindowsEmbeddedAsarIntegrity(
  executablePath: string,
): IntegrityEntry | null {
  const match = findWindowsIntegrityMatch(readFileSync(executablePath));
  return match ? { algorithm: match.algorithm, hash: match.hash } : null;
}

export function setWindowsEmbeddedAsarIntegrity(
  executablePath: string,
  hash: string,
): IntegrityUpdateResult | null {
  assertSha256(hash);
  const before = readFileSync(executablePath);
  const match = findWindowsIntegrityMatch(before);
  if (!match) return null;

  const normalizedHash = hash.toLowerCase();
  if (match.hash === normalizedHash) {
    return {
      algorithm: "SHA256",
      hash: normalizedHash,
      location: "windows-pe",
      previousHash: match.hash,
      changed: false,
    };
  }

  const fd = openSync(executablePath, "r+");
  try {
    const replacement = Buffer.from(normalizedHash, "ascii");
    const written = writeSync(fd, replacement, 0, replacement.length, match.valueOffset);
    if (written !== replacement.length) {
      throw new Error(
        `Short write updating Windows ASAR integrity metadata in ${executablePath}: ` +
          `${written}/${replacement.length} bytes`,
      );
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  const verified = getWindowsEmbeddedAsarIntegrity(executablePath);
  if (verified?.hash !== normalizedHash) {
    throw new Error(
      `Windows ASAR integrity metadata verification failed in ${executablePath}`,
    );
  }
  return {
    algorithm: "SHA256",
    hash: normalizedHash,
    location: "windows-pe",
    previousHash: match.hash,
    changed: true,
  };
}

function findWindowsIntegrityMatch(binary: Buffer): WindowsIntegrityMatch | null {
  const resourceRange = peSectionRange(binary, ".rsrc");
  if (!resourceRange) return null;
  const source = binary
    .subarray(resourceRange.start, resourceRange.end)
    .toString("latin1");
  const matches: WindowsIntegrityMatch[] = [];
  const markerPattern = new RegExp(
    WINDOWS_FILE_MARKER_RE.source,
    WINDOWS_FILE_MARKER_RE.flags,
  );
  let marker: RegExpExecArray | null;
  while ((marker = markerPattern.exec(source)) !== null) {
    const objectStart = source.lastIndexOf("{", marker.index);
    if (objectStart < 0) continue;
    const objectEnd = findJsonObjectEnd(source, objectStart);
    if (objectEnd < marker.index) continue;

    const objectText = source.slice(objectStart, objectEnd + 1);
    let parsed: { file?: unknown; alg?: unknown; value?: unknown };
    try {
      parsed = JSON.parse(objectText) as typeof parsed;
    } catch {
      continue;
    }
    if (
      typeof parsed.file !== "string" ||
      parsed.file.replaceAll("\\", "/").toLowerCase() !== WINDOWS_ASAR_FILE ||
      String(parsed.alg).toUpperCase() !== "SHA256" ||
      typeof parsed.value !== "string" ||
      !SHA256_RE.test(parsed.value)
    ) {
      continue;
    }

    const valueMatch = WINDOWS_VALUE_RE.exec(objectText);
    if (!valueMatch || valueMatch[1].toLowerCase() !== parsed.value.toLowerCase()) {
      throw new Error("Malformed Windows ASAR integrity metadata");
    }
    matches.push({
      algorithm: "SHA256",
      hash: parsed.value.toLowerCase(),
      valueOffset:
        resourceRange.start +
        objectStart +
        valueMatch.index +
        valueMatch[0].lastIndexOf(valueMatch[1]),
    });
  }

  if (matches.length > 1) {
    throw new Error(
      `Found multiple Windows ASAR integrity entries for ${WINDOWS_ASAR_FILE}`,
    );
  }
  return matches[0] ?? null;
}

function peSectionRange(binary: Buffer, sectionName: string): PeSectionRange | null {
  if (binary.length < 0x40 || binary.readUInt16LE(0) !== 0x5a4d) return null;
  const peOffset = binary.readUInt32LE(0x3c);
  if (
    peOffset < 0x40 ||
    peOffset + 24 > binary.length ||
    binary.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error("Invalid Windows PE executable");
  }

  const sectionCount = binary.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = binary.readUInt16LE(peOffset + 20);
  const sectionTable = peOffset + 24 + optionalHeaderSize;
  if (
    sectionCount < 1 ||
    sectionCount > 96 ||
    sectionTable + sectionCount * 40 > binary.length
  ) {
    throw new Error("Invalid Windows PE section table");
  }

  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40;
    const name = binary
      .subarray(offset, offset + 8)
      .toString("ascii")
      .replace(/\0+$/, "");
    if (name !== sectionName) continue;

    const rawSize = binary.readUInt32LE(offset + 16);
    const rawOffset = binary.readUInt32LE(offset + 20);
    const end = rawOffset + rawSize;
    if (rawSize < 1 || rawOffset < 1 || end > binary.length || end < rawOffset) {
      throw new Error(`Invalid ${sectionName} section range in Windows PE executable`);
    }
    return { start: rawOffset, end };
  }
  return null;
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function assertSha256(hash: string): void {
  if (!SHA256_RE.test(hash)) {
    throw new Error(`Invalid SHA-256 integrity hash: ${hash}`);
  }
}
