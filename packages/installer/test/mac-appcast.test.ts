import assert from "node:assert/strict";
import test from "node:test";
import { latestMacRelease } from "../src/mac-appcast.js";
const item = (build: string, arch = "arm64", minimum = "13.0") => `<item><s:version>${build}</s:version><s:shortVersionString>26.9.${build}</s:shortVersionString><s:hardwareRequirements>${arch}</s:hardwareRequirements><s:minimumSystemVersion>${minimum}</s:minimumSystemVersion><enclosure url="https://example.com/app.zip" length="123" s:edSignature="signature"/></item>`;
const feed = (...items: string[]) => `<rss xmlns:s="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items.join("")}</channel></rss>`;
test("appcast selects newest compatible release without depending on item order", () => {
  assert.deepEqual(latestMacRelease(feed(item("9"), item("20", "x64"), item("10"), item("30", "arm64", "30.0")), "arm64", "26.0"), { build: "10", version: "26.9.10", url: "https://example.com/app.zip", size: 123, signature: "signature" });
});
test("appcast reports no compatible release", () => {
  assert.equal(latestMacRelease(feed(item("10", "x64")), "arm64", "26.0"), null);
});
test("appcast errors are not interpreted as up-to-date", () => {
  assert.throws(() => latestMacRelease("<html>unavailable</html>", "arm64", "26"));
  assert.throws(() => latestMacRelease(feed("<item/>"), "arm64", "26"));
});
