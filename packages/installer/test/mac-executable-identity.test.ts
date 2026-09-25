import assert from "node:assert/strict";
import test from "node:test";
import { managedMacExecutable } from "../src/mac-executable-identity";

function executable(): Buffer {
  const binary = Buffer.alloc(64, 0);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x0100000c, 4);
  binary.writeUInt32LE(1, 16);
  binary.writeUInt32LE(24, 20);
  binary.writeUInt32LE(0x1b, 32);
  binary.writeUInt32LE(24, 36);
  binary.fill(0x42, 40, 56);
  binary.write("payload", 56);
  return binary;
}

test("managed desktop has a distinct deterministic UUID without altering code or source", () => {
  const original = executable();
  const before = Buffer.from(original);
  const managed = managedMacExecutable(original, "io.github.docacola.codexdc");
  assert.deepEqual(original, before);
  assert.notDeepEqual(managed.subarray(40, 56), original.subarray(40, 56));
  assert.deepEqual(managed.subarray(0, 40), original.subarray(0, 40));
  assert.deepEqual(managed.subarray(56), original.subarray(56));
  assert.deepEqual(managedMacExecutable(original, "io.github.docacola.codexdc"), managed);
  assert.notDeepEqual(managedMacExecutable(original, "other.app"), managed);
  const nextBuild = Buffer.from(original);
  nextBuild[40] = 0x43;
  assert.notDeepEqual(managedMacExecutable(nextBuild, "io.github.docacola.codexdc"), managed);
});

test("reject unsupported or malformed executable layouts before signing", () => {
  assert.throws(() => managedMacExecutable(Buffer.alloc(0), "test"), /arm64 Mach-O/);
  const missing = executable();
  missing.writeUInt32LE(0x19, 32);
  assert.throws(() => managedMacExecutable(missing, "test"), /one Mach-O UUID/);
  const truncated = executable();
  truncated.writeUInt32LE(100, 20);
  assert.throws(() => managedMacExecutable(truncated, "test"), /Truncated/);
  const malformed = executable();
  malformed.writeUInt32LE(0, 36);
  assert.throws(() => managedMacExecutable(malformed, "test"), /command size/);
});
