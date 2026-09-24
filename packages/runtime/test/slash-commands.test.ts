import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesSlashCommand,
  normalizeCommandName,
  parseComposerCommand,
} from "../src/preload/slash-commands";

test("normalizeCommandName strips leading slashes and normalizes case", () => {
  assert.equal(normalizeCommandName(" /Restart-Session "), "restart-session");
});

test("parseComposerCommand accepts only an exact slash command", () => {
  assert.equal(parseComposerCommand("/restart-session"), "restart-session");
  assert.equal(parseComposerCommand("  /RESTART-SESSION  "), "restart-session");
  assert.equal(parseComposerCommand("/restart-session now"), null);
  assert.equal(parseComposerCommand("prefix /restart-session"), null);
  assert.equal(parseComposerCommand("/restart_session"), null);
});

test("matchesSlashCommand searches names, titles, and aliases", () => {
  const command = {
    name: "restart-session",
    title: "Restart Codex backend",
    aliases: ["reload-cli"],
    execute() {},
  };

  assert.equal(matchesSlashCommand(command, "restart"), true);
  assert.equal(matchesSlashCommand(command, "backend"), true);
  assert.equal(matchesSlashCommand(command, "reload"), true);
  assert.equal(matchesSlashCommand(command, "archive"), false);
});
