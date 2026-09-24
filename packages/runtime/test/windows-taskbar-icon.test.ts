import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { windowsTaskbarIconPath, windowsTaskbarHelperArgs } from "../src/windows-taskbar-icon";

test("taskbar icon selection uses the system theme", () => {
  assert.equal(windowsTaskbarIconPath("resources", true), join("resources", "codex-dc", "taskbar-dark.ico"));
  assert.equal(windowsTaskbarIconPath("resources", false), join("resources", "codex-dc", "taskbar-light.ico"));
});

test("native taskbar helper preserves relaunch command quoting and identity", () => {
  const command = '"C:/Program Files/node.exe" "D:/Codex DC/cli.js" launch';
  const args = windowsTaskbarHelperArgs("runtime/taskbar-icons.ps1", "icons/dark.ico", "DOCaCola.CodexDC", 123, command, ["987654"]);
  assert.equal(args[args.indexOf("-IconPath") + 1], "icons/dark.ico");
  assert.equal(args[args.indexOf("-AppUserModelId") + 1], "DOCaCola.CodexDC");
  assert.equal(args[args.indexOf("-OwnerProcessId") + 1], "123");
  assert.equal(args[args.indexOf("-WindowHandles") + 1], "987654");
  assert.equal(Buffer.from(args[args.indexOf("-RelaunchCommandBase64") + 1], "base64").toString("utf8"), command);
});
