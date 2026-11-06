import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DiscoveredTweak } from "../src/tweak-discovery";
import { replacedStoreTweaks, retireReplacedTweaks, type ReplacementState } from "../src/tweak-replacement";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "codexdc-replacement-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tweaks = join(root, "tweaks"), data = join(root, "tweak-data");
  function install(id: string, metadata?: { repo: string }): DiscoveredTweak {
    const dir = join(tweaks, id);
    mkdirSync(dir, { recursive: true });
    if (metadata) writeFileSync(join(dir, ".codexpp-store.json"), JSON.stringify(metadata));
    return { dir, entry: join(dir, "index.js"), manifest: { id, name: id, version: "0.1.0" } };
  }
  return { data, install };
}

const entry = {
  repo: "DOCaCola/CodexDC-Tweaks",
  manifest: { id: "local.codex-lb", name: "codex-lb", version: "0.2.1", replaces: ["local.codex-lb-capabilities"] },
};

test("only Store installs from the entry's repository are replaced", (t) => {
  const { install } = fixture(t);
  const store = install("local.codex-lb-capabilities", { repo: "https://github.com/DOCaCola/CodexDC-Tweaks" });
  const discovered = [store, install("local.project-colors", { repo: "DOCaCola/CodexDC-Tweaks" })];
  assert.deepEqual(replacedStoreTweaks(entry, discovered), [store]);

  const elsewhere = { ...entry, repo: "someone/other-tweaks" };
  assert.deepEqual(replacedStoreTweaks(elsewhere, discovered), []);
  const manual = install("manual/local.codex-lb-capabilities");
  assert.deepEqual(replacedStoreTweaks(entry, [{ ...manual, manifest: store.manifest }]), []);
  assert.deepEqual(replacedStoreTweaks({ ...entry, manifest: { ...entry.manifest, replaces: undefined } }, discovered), []);
});

test("retiring a replaced tweak moves its settings and data to the successor", (t) => {
  const { data, install } = fixture(t);
  const old = install("local.codex-lb-capabilities", { repo: entry.repo });
  mkdirSync(join(data, old.manifest.id), { recursive: true });
  writeFileSync(join(data, old.manifest.id, "settings.json"), "{\"predictions\":true}");
  const state: ReplacementState = {
    tweaks: { [old.manifest.id]: { enabled: false }, "local.project-colors": { enabled: true } },
    tweakUpdateChecks: { [old.manifest.id]: {}, "local.project-colors": {} },
  };

  retireReplacedTweaks(entry.manifest.id, [old], data, state);

  assert.equal(existsSync(old.dir), false);
  assert.equal(existsSync(join(data, old.manifest.id)), false);
  assert.equal(readFileSync(join(data, entry.manifest.id, "settings.json"), "utf8"), "{\"predictions\":true}");
  assert.deepEqual(state, {
    tweaks: { "local.project-colors": { enabled: true }, [entry.manifest.id]: { enabled: false } },
    tweakUpdateChecks: { "local.project-colors": {} },
  });
});

test("the successor keeps settings and data it already has", (t) => {
  const { data, install } = fixture(t);
  const old = install("local.codex-lb-capabilities", { repo: entry.repo });
  for (const id of [old.manifest.id, entry.manifest.id]) {
    mkdirSync(join(data, id), { recursive: true });
    writeFileSync(join(data, id, "settings.json"), id);
  }
  const state: ReplacementState = { tweaks: { [old.manifest.id]: { enabled: false }, [entry.manifest.id]: { enabled: true } } };

  retireReplacedTweaks(entry.manifest.id, [old], data, state);

  assert.equal(readFileSync(join(data, entry.manifest.id, "settings.json"), "utf8"), entry.manifest.id);
  assert.equal(existsSync(join(data, old.manifest.id)), false);
  assert.deepEqual(state, { tweaks: { [entry.manifest.id]: { enabled: true } } });
});
