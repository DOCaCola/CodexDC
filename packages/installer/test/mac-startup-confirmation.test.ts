import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
const realRequire = createRequire(import.meta.url);

for (const nativePath of [path.posix, path.win32]) {
  test(`startup retention waits for a desktop window and confirms once (${nativePath.sep} paths)`, () => {
    const app = new EventEmitter();
    const calls: string[][] = [];
    const sourceRoot = nativePath.join(nativePath.sep, "source");
    const require = Object.assign((name: string) => {
      if (name === "../updater-discovery.js") return realRequire("../../runtime/platform/updater-discovery.js");
      if (name === "node:fs") return { readFileSync: () => JSON.stringify({ sourceRoot, nodePath: nativePath.join(nativePath.sep, "node"), installedAt: "installation-token" }) };
      if (name === "node:path") return nativePath;
      if (name === "node:module") return { _load: () => ({}) };
      if (name === "node:child_process") return { execFile: (_node: string, args: string[], _options: object, callback: Function) => {
        calls.push(args); callback(null, "{}", "");
      } };
      if (name === "electron") return { app, dialog: {} };
      throw new Error(name);
    }, { cache: {} });
    const module = { exports: {} as { start(api: object): void } };
    runInNewContext(readFileSync(new URL("../../runtime/platform/macos/index.js", import.meta.url), "utf8"), {
      module, require, process: { env: { CODEXDC_USER_ROOT: nativePath.join(nativePath.sep, "profile") } },
    });
    module.exports.start({ log: { info() {}, warn() {} } });
    const contents = (type: string, url: string) => Object.assign(new EventEmitter(), { getType: () => type, getURL: () => url });
    const auxiliary = contents("window", "about:blank");
    app.emit("web-contents-created", {}, auxiliary); auxiliary.emit("did-finish-load");
    assert.equal(calls.length, 0);
    const webview = contents("webview", "app://-/index.html");
    app.emit("web-contents-created", {}, webview); webview.emit("did-finish-load");
    assert.equal(calls.length, 0);
    const desktop = contents("window", "app://-/index.html");
    app.emit("web-contents-created", {}, desktop);
    assert.equal(calls.length, 0);
    desktop.emit("did-finish-load");
    assert.deepEqual(Array.from(calls[0]!), [nativePath.join(sourceRoot, "packages", "installer", "dist", "cli.js"), "mac-confirm-startup", "installation-token"]);
    const other = contents("window", "app://-/index.html");
    app.emit("web-contents-created", {}, other); other.emit("did-finish-load");
    assert.equal(calls.length, 1);
  });
}
