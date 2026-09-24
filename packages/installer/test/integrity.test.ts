import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getWindowsEmbeddedAsarIntegrity,
  prepareIntegrityUpdate,
  setWindowsEmbeddedAsarIntegrity,
} from "../src/integrity";
import type { CodexInstall } from "../src/platform";

const ORIGINAL = "1".repeat(64);
const PATCHED = "a".repeat(64);

test("reads and rewrites the Windows PE-embedded ASAR integrity manifest", () => {
  withTempExecutable((executable) => {
    const before = readFileSync(executable);
    assert.deepEqual(getWindowsEmbeddedAsarIntegrity(executable), {
      algorithm: "SHA256",
      hash: ORIGINAL,
    });

    const result = setWindowsEmbeddedAsarIntegrity(executable, PATCHED);
    assert.deepEqual(result, {
      algorithm: "SHA256",
      hash: PATCHED,
      location: "windows-pe",
      previousHash: ORIGINAL,
      changed: true,
    });
    assert.deepEqual(getWindowsEmbeddedAsarIntegrity(executable), {
      algorithm: "SHA256",
      hash: PATCHED,
    });

    const after = readFileSync(executable);
    assert.equal(after.length, before.length);
    assert.equal(
      countChangedBytes(before, after),
      PATCHED.length,
    );
  });
});

test("accepts reordered Windows integrity fields and leaves matching hashes unchanged", () => {
  withTempExecutable(
    (executable) => {
      const before = readFileSync(executable);
      const result = setWindowsEmbeddedAsarIntegrity(executable, ORIGINAL);
      assert.equal(result?.changed, false);
      assert.deepEqual(readFileSync(executable), before);
    },
    `{"value":"${ORIGINAL}","alg":"sha256","file":"resources\\\\app.asar"}`,
  );
});

test("returns null when a Windows executable has no embedded ASAR integrity entry", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-integrity-"));
  try {
    const executable = join(root, "ChatGPT.exe");
    writeFileSync(executable, makePeWithResource("not an integrity manifest"));
    assert.equal(getWindowsEmbeddedAsarIntegrity(executable), null);
    assert.equal(setWindowsEmbeddedAsarIntegrity(executable, PATCHED), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects ambiguous Windows ASAR integrity entries", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-integrity-"));
  try {
    const executable = join(root, "ChatGPT.exe");
    const entry =
      `{"file":"resources\\\\app.asar","alg":"SHA256","value":"${ORIGINAL}"}`;
    writeFileSync(
      executable,
      makePeWithResource(`${entry}PADDING${entry}`),
    );
    assert.throws(
      () => getWindowsEmbeddedAsarIntegrity(executable),
      /multiple Windows ASAR integrity entries/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepares integrity updates before mutation and rejects stale plans", () => {
  withTempExecutable((executable) => {
    const install = fakeWindowsInstall(executable);
    assert.throws(
      () => prepareIntegrityUpdate(install, "2".repeat(64)),
      /does not match the current app\.asar before patching/,
    );

    const plan = prepareIntegrityUpdate(install, ORIGINAL);
    assert.ok(plan);
    setWindowsEmbeddedAsarIntegrity(executable, "b".repeat(64));
    assert.throws(
      () => plan.write(PATCHED),
      /changed while CodexDC was patching/,
    );
  });
});

function withTempExecutable(
  run: (executable: string) => void,
  object = `{"file":"resources\\\\app.asar","alg":"SHA256","value":"${ORIGINAL}"}`,
): void {
  const root = mkdtempSync(join(tmpdir(), "codexpp-integrity-"));
  try {
    const executable = join(root, "ChatGPT.exe");
    writeFileSync(
      executable,
      makePeWithResource(`random[${object}]PADDINGXPADDINGX`),
    );
    run(executable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makePeWithResource(contents: string): Buffer {
  const peOffset = 0x80;
  const optionalHeaderSize = 0xf0;
  const sectionTable = peOffset + 24 + optionalHeaderSize;
  const resourceOffset = 0x200;
  const resource = Buffer.from(contents, "ascii");
  const resourceSize = Math.max(0x200, resource.length);
  const binary = Buffer.alloc(resourceOffset + resourceSize);

  binary.writeUInt16LE(0x5a4d, 0);
  binary.writeUInt32LE(peOffset, 0x3c);
  binary.write("PE\0\0", peOffset, "ascii");
  binary.writeUInt16LE(1, peOffset + 6);
  binary.writeUInt16LE(optionalHeaderSize, peOffset + 20);
  binary.write(".rsrc", sectionTable, "ascii");
  binary.writeUInt32LE(resourceSize, sectionTable + 16);
  binary.writeUInt32LE(resourceOffset, sectionTable + 20);
  resource.copy(binary, resourceOffset);
  return binary;
}

function fakeWindowsInstall(executable: string): CodexInstall {
  const appRoot = join(executable, "..");
  return {
    appRoot,
    resourcesDir: join(appRoot, "resources"),
    asarPath: join(appRoot, "resources", "app.asar"),
    metaPath: null,
    electronBinary: executable,
    executable,
    appName: "ChatGPT",
    appUserModelId: "DOCaCola.CodexDC",
    bundleId: null,
    channel: "stable",
    platform: "win32",
  };
}

function countChangedBytes(before: Buffer, after: Buffer): number {
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) changed += 1;
  }
  return changed;
}
