import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../loader.cjs", import.meta.url), "utf8").split("function appendCappedLog")[0]!;
function run(platform: string, ready?: string, failures: { bootstrap?: boolean; log?: Error } = {}) {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  let unreferenced = false;
  child.unref = () => { unreferenced = true; };
  const calls: unknown[][] = [];
  const exits: number[] = [];
  const errors: string[] = [];
  const dialogs: string[][] = [];
  const logWrites: string[] = [];
  const closed: number[] = [];
  const process = {
    platform, env: { CODEXDC_DESKTOP_READY: ready }, pid: 123,
    resourcesPath: "/app/Resources", argv: ["/app/ChatGPT", "--example"],
    exit: (code: number) => exits.push(code), stderr: { write: (s: string) => errors.push(s) },
  };
  const require = (id: string) => {
    switch (id) {
      case "node:path": return path;
      case "node:fs": return {
        readFileSync: () => JSON.stringify({ maintenanceNode: "/node", maintenanceCli: "/cli" }),
        mkdirSync: () => {},
        openSync: (file: string, flags: string) => { logWrites.push(`${flags} ${file}`); return 7; },
        writeSync: (_fd: number, text: string) => {
          if (failures.log) throw failures.log;
          logWrites.push(text);
        },
        closeSync: (fd: number) => { closed.push(fd); },
      };
      case "node:module": return {};
      case "./package.json": return { __codexpp: { userRoot: "/profile" } };
      case "node:child_process": return { spawn: (...args: unknown[]) => { calls.push(args); return child; } };
      case path.join("/profile", "runtime", "desktop-bootstrap.js"): return {
        prepareDesktop: () => { if (failures.bootstrap) throw new Error("selected CLI is missing"); },
      };
      case "electron": return {
        app: { exit: (code: number) => exits.push(code) },
        dialog: { showErrorBox: (...args: string[]) => { dialogs.push(args); } },
      };
      default: throw new Error(id);
    }
  };
  const continued = compileFunction(source + "\nreturn true;", ["require", "process"])(require, process);
  return { child, calls, exits, errors, dialogs, logWrites, closed, process, continued, unreferenced: () => unreferenced };
}
test("Finder launch hands off arguments and parent pid with output in the launch log", () => {
  const r = run("darwin");
  assert.equal(r.continued, undefined);
  assert.deepEqual(r.calls, [["/node", ["/cli", "launch"], {
    detached: true, stdio: ["ignore", 7, 7], env: {
      CODEXDC_DESKTOP_READY: undefined, CODEXDC_HOME: "/profile", CODEXDC_LAUNCH_PARENT: "123",
      CODEXDC_DESKTOP_ARGS: '["--example"]',
    },
  }]]);
  assert.equal(r.logWrites[0], `a ${path.join("/profile", "log", "launch.log")}`);
  assert.match(r.logWrites[1]!, /\] launch\n$/);
  r.child.emit("spawn");
  assert.deepEqual(r.closed, [7]);
  assert.deepEqual(r.exits, [0]);
  assert.equal(r.unreferenced(), true);
});
test("handoff failure displays the reason before exiting", () => {
  const r = run("darwin");
  r.child.emit("error", new Error("failed"));
  assert.deepEqual(r.exits, [1]);
  assert.match(r.errors[0]!, /failed/);
  assert.deepEqual(r.dialogs, [["CodexDC could not start", "Could not start launch maintenance: failed"]]);
  assert.equal(r.continued, undefined);
});
test("a launch log write error displays the reason without spawning maintenance", () => {
  const r = run("darwin", undefined, { log: new Error("no space left on device") });
  assert.deepEqual(r.dialogs, [["CodexDC could not start", "Could not start launch maintenance: no space left on device"]]);
  assert.deepEqual(r.closed, [7]);
  assert.deepEqual(r.exits, [1]);
  assert.equal(r.calls.length, 0);
});
test("prepared desktop consumes readiness marker and continues", () => {
  const r = run("darwin", "1");
  assert.equal(r.continued, true);
  assert.equal(r.calls.length, 0);
  assert.equal("CODEXDC_DESKTOP_READY" in r.process.env, false);
});
test("Windows launch continues directly", () => {
  const r = run("win32");
  assert.equal(r.continued, true);
  assert.equal(r.calls.length, 0);
});
test("Windows preparation failure shows an error and never hands off to upstream Codex", () => {
  const r = run("win32", undefined, { bootstrap: true });
  assert.equal(r.continued, undefined);
  assert.deepEqual(r.exits, [1]);
  assert.match(r.dialogs[0]![1]!, /selected CLI is missing/);
});
