import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyMacArchive } from "../src/mac-download.js";
import { selectMacSource } from "../src/mac-source.js";
import type { InstallerState } from "../src/state.js";

test("archive verification rejects modified downloads and wrong publisher keys", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const data = Buffer.from("publisher archive");
  const signature = sign(null, data, privateKey).toString("base64");
  verifyMacArchive(data, signature, raw);
  assert.throws(() => verifyMacArchive(Buffer.from("tampered"), signature, raw), /verification failed/);
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  assert.throws(() => verifyMacArchive(data, signature, other), /verification failed/);
});
test("startup repair keeps newer downloaded source instead of downgrading to official app", () => {
  const state = { officialAppRoot: "/official", downloadedAppRoot: "/downloaded" } as InstallerState;
  assert.equal(selectMacSource(state, p => p === "/official" ? "10954" : "11645"), "/downloaded");
  assert.equal(selectMacSource(state, p => p === "/official" ? "12000" : "11645"), "/official");
  assert.equal(selectMacSource(state, () => "11645"), "/official");
});
