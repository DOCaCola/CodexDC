import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const LC_UUID = 0x1b;

/** Give the managed desktop its own build identity before code signing.
 * macOS Local Network privacy uses executable UUIDs as well as bundle IDs.
 * The supported macOS distribution is a thin arm64 Mach-O executable.
 */
export function managedMacExecutable(binary: Buffer, bundleId: string): Buffer {
  if (binary.length < 32 || binary.readUInt32LE(0) !== MH_MAGIC_64 ||
      binary.readUInt32LE(4) !== CPU_TYPE_ARM64) {
    throw new Error("Expected an arm64 Mach-O desktop executable.");
  }
  const end = 32 + binary.readUInt32LE(20);
  if (end > binary.length) throw new Error("Truncated Mach-O load commands.");
  let offset = 32;
  let uuidOffset: number | undefined;
  for (let i = 0; i < binary.readUInt32LE(16); i++) {
    if (offset + 8 > end) throw new Error("Truncated Mach-O load command.");
    const command = binary.readUInt32LE(offset);
    const size = binary.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error("Invalid Mach-O load command size.");
    if (command === LC_UUID) {
      if (size !== 24 || uuidOffset !== undefined) throw new Error("Invalid Mach-O UUID command.");
      uuidOffset = offset + 8;
    }
    offset += size;
  }
  if (offset !== end || uuidOffset === undefined) throw new Error("Desktop executable must have one Mach-O UUID.");

  // UUIDv8: deterministic for this managed identity and upstream build, unique
  // from the publisher's executable. Always start from the official copy.
  const uuid = createHash("sha256").update(bundleId).update("\0")
    .update(binary.subarray(uuidOffset, uuidOffset + 16)).digest().subarray(0, 16);
  uuid[6] = (uuid[6]! & 0x0f) | 0x80;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  const managed = Buffer.from(binary);
  uuid.copy(managed, uuidOffset);
  return managed;
}

export function writeManagedMacExecutableIdentity(path: string, bundleId: string): void {
  writeFileSync(path, managedMacExecutable(readFileSync(path), bundleId));
}
