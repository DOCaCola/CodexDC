import assert from "node:assert/strict";
import test from "node:test";
import { placeSettingsGroupsAfterPersonal } from "../src/preload/settings-sidebar-order";

// Navigation fixture with DOM move semantics and a count of observer-producing
// writes. Native sections can be removed and rebuilt independently of ours.
class Section {
  parent: Sidebar | null = null;
  constructor(readonly name: string, readonly hasGeneralPanel = false) {}
  querySelector(selector: string): Section | null {
    assert.equal(selector, '[data-settings-panel-slug="general-settings"]');
    return this.hasGeneralPanel ? this : null;
  }
  get nextElementSibling(): Section | null {
    return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
}

class Sidebar {
  writes = 0;
  constructor(readonly children: Section[]) {
    for (const section of children) section.parent = this;
  }
  insertBefore(section: Section, before: Section | null): void {
    const current = this.children.indexOf(section);
    if (current !== -1) this.children.splice(current, 1);
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, section);
    section.parent = this;
    this.writes++;
  }
  get names(): string[] { return this.children.map((section) => section.name); }
}

function place(sidebar: Sidebar, nav: Section, pages: Section | null = null): void {
  placeSettingsGroupsAfterPersonal(
    sidebar as unknown as HTMLElement,
    nav as unknown as HTMLElement,
    pages as unknown as HTMLElement | null,
  );
}

test("Codex-DC follows Personal on initial settings mount", () => {
  const nav = new Section("Codex-DC");
  const sidebar = new Sidebar([
    new Section("Personal", true), new Section("Integrations"),
    new Section("Coding"), new Section("Archived"), nav,
  ]);
  place(sidebar, nav);
  assert.deepEqual(sidebar.names, ["Personal", "Codex-DC", "Integrations", "Coding", "Archived"]);
});

test("clearing search restores order after native groups are rebuilt", () => {
  const nav = new Section("Codex-DC");
  const sidebar = new Sidebar([nav]);
  place(sidebar, nav);
  assert.equal(sidebar.writes, 0);

  sidebar.insertBefore(new Section("Personal", true), null);
  sidebar.insertBefore(new Section("Integrations"), null);
  sidebar.insertBefore(new Section("Coding"), null);
  place(sidebar, nav);
  assert.deepEqual(sidebar.names, ["Personal", "Codex-DC", "Integrations", "Coding"]);
});

test("tweak pages follow Codex-DC without repeated observer writes", () => {
  const nav = new Section("Codex-DC");
  const pages = new Section("Tweaks");
  const sidebar = new Sidebar([
    pages, nav, new Section("Personal", true), new Section("Integrations"),
  ]);
  place(sidebar, nav, pages);
  assert.deepEqual(sidebar.names, ["Personal", "Codex-DC", "Tweaks", "Integrations"]);
  const writes = sidebar.writes;
  place(sidebar, nav, pages);
  assert.equal(sidebar.writes, writes);
});

test("filtering out Personal preserves placement until it returns", () => {
  const nav = new Section("Codex-DC");
  const sidebar = new Sidebar([new Section("Integrations"), nav]);
  place(sidebar, nav);
  assert.deepEqual(sidebar.names, ["Integrations", "Codex-DC"]);
  assert.equal(sidebar.writes, 0);
});
