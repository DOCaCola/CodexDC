import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pngFramesToIco, stageWindowsTaskbarIcons } from "../src/windows-taskbar-icons";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64");

test("ICO directory retains original PNG payloads and represents the 256px size", () => {
  const large = Buffer.from(pixel);
  large.writeUInt32BE(256, 16);
  large.writeUInt32BE(256, 20);
  const ico = pngFramesToIco([pixel, large]);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico[6], 1);
  assert.equal(ico[22], 0, "256 pixels is encoded as zero in the ICO directory");
  const first = ico.readUInt32LE(18);
  const second = ico.readUInt32LE(34);
  assert.deepEqual(ico.subarray(first, second), pixel);
  assert.deepEqual(ico.subarray(second), large);
  assert.throws(() => pngFramesToIco([]), /no taskbar icon frames/);
  assert.throws(() => pngFramesToIco([Buffer.from("not PNG")]), /Invalid/);
});

test("stages the manifest's separate light and dark artwork without shipping stock assets", () => {
  const root = mkdtempSync(join(tmpdir(), "codexdc-taskbar-"));
  try {
    const assets = join(root, "images");
    mkdirSync(assets);
    writeFileSync(join(root, "AppxManifest.xml"), '<VisualElements Square44x44Logo="images/CustomLogo.png"/>');
    const light = Buffer.concat([pixel, Buffer.from("light fixture")]);
    writeFileSync(join(assets, "CustomLogo.targetsize-1_altform-unplated.png"), pixel);
    writeFileSync(join(assets, "CustomLogo.targetsize-1_altform-lightunplated.png"), light);
    writeFileSync(join(assets, "OtherLogo.targetsize-1_altform-unplated.png"), "unrelated");
    const resources = join(root, "managed", "resources");
    stageWindowsTaskbarIcons(root, resources);
    assert.deepEqual(readFileSync(join(resources, "codex-dc", "taskbar-dark.ico")).subarray(22), pixel);
    assert.deepEqual(readFileSync(join(resources, "codex-dc", "taskbar-light.ico")).subarray(22), light);
    rmSync(join(assets, "CustomLogo.targetsize-1_altform-lightunplated.png"));
    assert.throws(() => stageWindowsTaskbarIcons(root, resources), /no taskbar icon frames/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
