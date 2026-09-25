import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../loader.cjs", import.meta.url), "utf8").split("function appendCappedLog")[0]!;
function run(platform: string, ready?: string) {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  let unreferenced = false;
  child.unref = () => { unreferenced = true; };
  const calls: unknown[][] = [];
  const exits: number[] = [];
  const errors: string[] = [];
  const process = {
    platform, env: { CODEXDC_DESKTOP_READY: ready }, pid: 123,
    resourcesPath: "/app/Resources", argv: ["/app/ChatGPT", "--example"],
    exit: (code: number) => exits.push(code), stderr: { write: (s: string) => errors.push(s) },
  };
  const require = (id: string) => {
    switch (id) {
      case "node:path": return path;
      case "node:fs": return { readFileSync: () => JSON.stringify({ maintenanceNode: "/node", maintenanceCli: "/cli" }) };
      case "node:module": return {};
      case "./package.json": return { __codexpp: { userRoot: "/profile" } };
      case "node:child_process": return { spawn: (...args: unknown[]) => { calls.push(args); return child; } };
      default: throw new Error(id);
    }
  };
  const continued = compileFunction(source + "\nreturn true;", ["require", "process"])(require, process);
  return { child, calls, exits, errors, process, continued, unreferenced: () => unreferenced };
}
test("Finder launch hands off arguments and parent pid before loading desktop", () => {
  const r = run("darwin");
  assert.equal(r.continued, undefined);
  assert.deepEqual(r.calls, [["/node", ["/cli", "launch"], {
    detached: true, stdio: "ignore", env: {
      CODEXDC_DESKTOP_READY: undefined, CODEXDC_HOME: "/profile", CODEXDC_LAUNCH_PARENT: "123",
      CODEXDC_DESKTOP_ARGS: '["--example"]',
    },
  }]]);
  r.child.emit("spawn");
  assert.deepEqual(r.exits, [0]);
  assert.equal(r.unreferenced(), true);
});
test("handoff failure exits without loading desktop", () => {
  const r = run("darwin");
  r.child.emit("error", new Error("failed"));
  assert.deepEqual(r.exits, [1]);
  assert.match(r.errors[0]!, /failed/);
  assert.equal(r.continued, undefined);
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
