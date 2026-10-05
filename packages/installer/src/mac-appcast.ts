import { DOMParser } from "@xmldom/xmldom";
export interface MacRelease { build: string; version: string; url: string; signature: string; size: number }
const SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle";
function compare(left: string, right: string) {
  if (![left, right].every(v => /^\d+(?:\.\d+)*$/.test(v))) throw new Error("Invalid appcast version.");
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0n) - (b[i] ?? 0n);
    if (d) return d > 0n ? 1 : -1;
  }
  return 0;
}
export function latestMacRelease(xml: string, arch: string, osVersion: string) {
  const doc = new DOMParser({ onError: level => { if (level !== "warning") throw new Error("Invalid update feed XML."); } }).parseFromString(xml, "application/xml");
  if (doc.documentElement?.tagName !== "rss") throw new Error("Expected a Sparkle RSS feed.");
  let latest: MacRelease | null = null;
  for (const item of Array.from(doc.getElementsByTagName("item"))) {
    const value = (key: string) => item.getElementsByTagNameNS(SPARKLE, key)[0]?.textContent?.trim();
    const hardware = value("hardwareRequirements");
    if (hardware && !hardware.split(/[\s,]+/).includes(arch)) continue;
    const minimum = value("minimumSystemVersion"), maximum = value("maximumSystemVersion");
    if (minimum && compare(osVersion, minimum) < 0 || maximum && compare(osVersion, maximum) > 0) continue;
    const build = value("version"), version = value("shortVersionString");
    if (!build || !version) throw new Error("Update feed item has no version.");
    const enclosure = Array.from(item.childNodes).find(node => node.nodeType === 1 && node.nodeName === "enclosure") as import("@xmldom/xmldom").Element | undefined;
    const url = enclosure?.getAttribute("url"), signature = enclosure?.getAttributeNS(SPARKLE, "edSignature");
    const size = Number(enclosure?.getAttribute("length"));
    if (!url || new URL(url).protocol !== "https:" || !signature || !Number.isSafeInteger(size) || size <= 0) throw new Error("Update feed has no signed full archive.");
    if (!latest || compare(build, latest.build) > 0) latest = { build, version, url, signature, size };
  }
  return latest;
}
