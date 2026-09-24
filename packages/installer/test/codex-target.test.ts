import assert from "node:assert/strict";
import test from "node:test";
import { resolveManagedCodexInstall } from "../src/codex-target";

test("resolveManagedCodexInstall honors an explicit override", () => {
  const calls: Array<string | undefined> = [];
  const codex = resolveManagedCodexInstall({
    override: "D:/override",
    recordedAppRoot: "D:/recorded",
    platform: "win32",
    locate: (value?: string) => {
      calls.push(value);
      return {
        appRoot: value ?? "D:/default",
        resourcesDir: "",
        asarPath: "",
        metaPath: null,
        electronBinary: "",
        executable: "",
        appName: "Codex",
        bundleId: null,
        channel: "stable",
        platform: "win32",
      };
    },
  });

  assert.equal(codex.appRoot, "D:/override");
  assert.deepEqual(calls, ["D:/override"]);
});

test("resolveManagedCodexInstall prefers the current detected Windows install over recorded state", () => {
  const calls: Array<string | undefined> = [];
  const codex = resolveManagedCodexInstall({
    recordedAppRoot: "D:/stale",
    platform: "win32",
    locate: (value?: string) => {
      calls.push(value);
      return {
        appRoot: value ?? "D:/current",
        resourcesDir: "",
        asarPath: "",
        metaPath: null,
        electronBinary: "",
        executable: "",
        appName: "Codex",
        bundleId: null,
        channel: "stable",
        platform: "win32",
      };
    },
  });

  assert.equal(codex.appRoot, "D:/current");
  assert.deepEqual(calls, [undefined]);
});

test("resolveManagedCodexInstall falls back to recorded Windows state when current detection fails", () => {
  const calls: Array<string | undefined> = [];
  const codex = resolveManagedCodexInstall({
    recordedAppRoot: "D:/recorded",
    platform: "win32",
    locate: (value?: string) => {
      calls.push(value);
      if (value === undefined) {
        throw new Error("current install not found");
      }
      return {
        appRoot: value,
        resourcesDir: "",
        asarPath: "",
        metaPath: null,
        electronBinary: "",
        executable: "",
        appName: "Codex",
        bundleId: null,
        channel: "stable",
        platform: "win32",
      };
    },
  });

  assert.equal(codex.appRoot, "D:/recorded");
  assert.deepEqual(calls, [undefined, "D:/recorded"]);
});

test("resolveManagedCodexInstall keeps using recorded non-Windows installs", () => {
  const calls: Array<string | undefined> = [];
  const codex = resolveManagedCodexInstall({
    recordedAppRoot: "/Applications/Codex.app",
    platform: "darwin",
    locate: (value?: string) => {
      calls.push(value);
      return {
        appRoot: value ?? "/Applications/Detected.app",
        resourcesDir: "",
        asarPath: "",
        metaPath: null,
        electronBinary: "",
        executable: "",
        appName: "Codex",
        bundleId: null,
        channel: "stable",
        platform: "darwin",
      };
    },
  });

  assert.equal(codex.appRoot, "/Applications/Codex.app");
  assert.deepEqual(calls, ["/Applications/Codex.app"]);
});
