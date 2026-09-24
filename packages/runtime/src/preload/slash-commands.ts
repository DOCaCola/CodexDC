import type {
  SlashCommand,
  SlashCommandHandle,
} from "@codexdc/sdk";

const INLINE_SURFACE_SELECTOR = "[data-composer-overlay-floating-ui='true']";
const DIALOG_SURFACE_SELECTOR = "[role='dialog'][aria-label='Slash command menu']";
const COMMAND_ITEM_SELECTOR = "[data-codexpp-slash-command]";
const EDITOR_SELECTOR = "[contenteditable='true']";
const STYLE_ID = "codexpp-slash-command-styles";

interface RegisteredCommand {
  ownerId: string;
  command: SlashCommand;
}

const commands = new Map<string, RegisteredCommand>();
const runningCommands = new Set<string>();

let observer: MutationObserver | null = null;
let refreshScheduled = false;
let domReadyHandler: (() => void) | null = null;
let lastEditor: HTMLElement | null = null;

export function registerSlashCommand(
  ownerId: string,
  command: SlashCommand,
): SlashCommandHandle {
  const name = normalizeCommandName(command.name);
  validateCommand(command, name);

  const existing = commands.get(name);
  if (existing && existing.ownerId !== ownerId) {
    throw new Error(`slash command /${name} is already registered by ${existing.ownerId}`);
  }

  const registeredCommand: RegisteredCommand = {
    ownerId,
    command: {
      ...command,
      name,
      aliases: command.aliases?.map(normalizeCommandName),
    },
  };
  commands.set(name, registeredCommand);
  ensureStarted();
  scheduleRefresh();

  let registered = true;
  return {
    unregister() {
      if (!registered) return;
      registered = false;
      const current = commands.get(name);
      if (current === registeredCommand) {
        commands.delete(name);
      }
      if (commands.size === 0) {
        stopSlashCommandHost();
      } else {
        scheduleRefresh();
      }
    },
  };
}

export function clearSlashCommands(ownerId?: string): void {
  if (ownerId == null) {
    commands.clear();
  } else {
    for (const [name, registered] of commands) {
      if (registered.ownerId === ownerId) {
        commands.delete(name);
      }
    }
  }

  if (commands.size === 0) {
    stopSlashCommandHost();
  } else {
    scheduleRefresh();
  }
}

export function normalizeCommandName(value: string): string {
  return String(value ?? "").trim().replace(/^\/+/, "").toLowerCase();
}

export function parseComposerCommand(value: string): string | null {
  const normalized = String(value ?? "")
    .replace(/\u200b/g, "")
    .trim();
  const match = /^\/([a-z0-9][a-z0-9-]*)$/i.exec(normalized);
  return match ? normalizeCommandName(match[1]) : null;
}

export function matchesSlashCommand(command: SlashCommand, query: string): boolean {
  const normalized = normalizeCommandName(query);
  if (normalized.length === 0) return true;

  const candidates = [
    normalizeCommandName(command.name),
    command.title.toLowerCase(),
    ...(command.aliases ?? []).map((alias) => normalizeCommandName(alias)),
  ];
  return candidates.some((candidate) => candidate.includes(normalized));
}

function validateCommand(command: SlashCommand, name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("slash command name must contain lowercase letters, numbers, or dashes");
  }
  if (typeof command.title !== "string" || command.title.trim() === "") {
    throw new Error(`slash command /${name} requires a title`);
  }
  if (typeof command.execute !== "function") {
    throw new Error(`slash command /${name} requires execute()`);
  }

  for (const alias of command.aliases ?? []) {
    const normalized = normalizeCommandName(alias);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
      throw new Error(`slash command /${name} has an invalid alias`);
    }
  }
}

function ensureStarted(): void {
  installStyles();
  installEventListeners();

  if (observer || domReadyHandler) return;
  const begin = () => {
    domReadyHandler = null;
    if (!document.body || commands.size === 0) return;
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    scheduleRefresh();
  };

  if (document.readyState === "loading") {
    domReadyHandler = begin;
    document.addEventListener("DOMContentLoaded", domReadyHandler, { once: true });
  } else {
    begin();
  }
}

function stopSlashCommandHost(): void {
  if (domReadyHandler) {
    document.removeEventListener("DOMContentLoaded", domReadyHandler);
    domReadyHandler = null;
  }
  observer?.disconnect();
  observer = null;
  refreshScheduled = false;
  runningCommands.clear();
  removeInjectedItems();
  removeEventListeners();
}

function installEventListeners(): void {
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("input", onInput, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
}

function removeEventListeners(): void {
  document.removeEventListener("keydown", onKeyDown, true);
  document.removeEventListener("submit", onSubmit, true);
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("click", onClick, true);
}

function onInput(event: Event): void {
  const editor = findEditor(event.target);
  if (editor) {
    lastEditor = editor;
  }
  scheduleRefresh();
}

function onKeyDown(event: KeyboardEvent): void {
  const editor = findEditor(event.target);
  if (editor) {
    lastEditor = editor;
  }

  if (
    event.key !== "Enter"
    || event.shiftKey
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || !editor
  ) {
    return;
  }

  const registered = commandForComposer(editor);
  if (!registered) return;

  consumeEvent(event);
  clearEditor(editor);
  void executeCommand(registered);
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  const editor = form?.querySelector<HTMLElement>(EDITOR_SELECTOR) ?? lastEditor;
  if (!editor) return;

  const registered = commandForComposer(editor);
  if (!registered) return;

  consumeEvent(event);
  clearEditor(editor);
  void executeCommand(registered);
}

function onPointerDown(event: PointerEvent): void {
  if (!findCommandItem(event.target)) return;
  consumeEvent(event);
}

function onClick(event: MouseEvent): void {
  const item = findCommandItem(event.target);
  if (!item) return;

  const name = normalizeCommandName(item.dataset.codexppSlashCommand ?? "");
  const registered = commands.get(name);
  if (!registered) return;

  consumeEvent(event);
  if (lastEditor?.isConnected) {
    clearEditor(lastEditor);
  }
  removeInjectedItems();
  void executeCommand(registered);
}

function consumeEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function findEditor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const editor = target.closest<HTMLElement>(EDITOR_SELECTOR);
  return editor?.isContentEditable ? editor : null;
}

function findCommandItem(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(COMMAND_ITEM_SELECTOR)
    : null;
}

function commandForComposer(editor: HTMLElement): RegisteredCommand | null {
  const name = parseComposerCommand(editor.textContent ?? "");
  if (!name) return null;

  const direct = commands.get(name);
  if (direct) return direct;

  for (const registered of commands.values()) {
    if (registered.command.aliases?.includes(name)) {
      return registered;
    }
  }
  return null;
}

async function executeCommand(registered: RegisteredCommand): Promise<void> {
  const name = registered.command.name;
  if (runningCommands.has(name)) return;

  runningCommands.add(name);
  scheduleRefresh();
  try {
    await registered.command.execute();
  } catch (error) {
    console.error(`[codexdc] slash command /${name} failed`, error);
  } finally {
    runningCommands.delete(name);
    scheduleRefresh();
  }
}

function clearEditor(editor: HTMLElement): void {
  editor.focus();
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection?.removeAllRanges();
  selection?.addRange(range);

  if (!document.execCommand("delete", false)) {
    editor.textContent = "";
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "deleteContentBackward",
    }));
  }
}

function scheduleRefresh(): void {
  if (refreshScheduled || commands.size === 0) return;
  refreshScheduled = true;
  queueMicrotask(() => {
    refreshScheduled = false;
    refreshMenus();
  });
}

function refreshMenus(): void {
  const editor = activeEditor();
  const inlineQuery = editor ? inlineSlashQuery(editor.textContent ?? "") : null;

  for (const surface of Array.from(
    document.querySelectorAll<HTMLElement>(INLINE_SURFACE_SELECTOR),
  )) {
    if (surface.matches(DIALOG_SURFACE_SELECTOR)) continue;
    if (inlineQuery == null) {
      removeInjectedItems(surface);
      continue;
    }
    renderCommands(surface, inlineQuery);
  }

  for (const dialog of Array.from(
    document.querySelectorAll<HTMLElement>(DIALOG_SURFACE_SELECTOR),
  )) {
    const input = dialog.querySelector<HTMLInputElement>("input");
    renderCommands(dialog, input?.value ?? "");
  }
}

function activeEditor(): HTMLElement | null {
  const focused = findEditor(document.activeElement);
  if (focused) {
    lastEditor = focused;
    return focused;
  }
  return lastEditor?.isConnected ? lastEditor : null;
}

function inlineSlashQuery(value: string): string | null {
  const normalized = String(value ?? "").replace(/\u200b/g, "").trim();
  const match = /^\/([^/\r\n\s]*)$/i.exec(normalized);
  return match ? match[1] : null;
}

function renderCommands(surface: HTMLElement, query: string): void {
  const matching = [...commands.values()]
    .filter(({ command }) => matchesSlashCommand(command, query));
  const existing = new Map(
    Array.from(surface.querySelectorAll<HTMLElement>(COMMAND_ITEM_SELECTOR))
      .map((item) => [item.dataset.codexppSlashCommand ?? "", item]),
  );

  for (const { command } of matching) {
    let item = existing.get(command.name);
    if (!item) {
      item = createCommandItem(command, surface);
      findMenuContainer(surface)?.prepend(item);
    }
    item.dataset.disabled = runningCommands.has(command.name) ? "true" : "false";
    item.setAttribute("aria-disabled", runningCommands.has(command.name) ? "true" : "false");
    existing.delete(command.name);
  }

  for (const item of existing.values()) {
    item.remove();
  }

  const hasInjectedItems = matching.length > 0;
  for (const empty of Array.from(
    surface.querySelectorAll<HTMLElement>("[cmdk-empty], [data-empty='true']"),
  )) {
    empty.hidden = hasInjectedItems;
  }
}

function findMenuContainer(surface: HTMLElement): HTMLElement | null {
  const stockItem = surface.querySelector<HTMLElement>(
    "[cmdk-item], [role='option']:not([data-codexpp-slash-command])",
  );
  if (stockItem?.parentElement) return stockItem.parentElement;

  return surface.querySelector<HTMLElement>("[cmdk-list], [role='listbox']")
    ?? surface.firstElementChild as HTMLElement | null
    ?? surface;
}

function createCommandItem(command: SlashCommand, surface: HTMLElement): HTMLElement {
  const template = surface.querySelector<HTMLElement>(
    "[cmdk-item], [role='option']:not([data-codexpp-slash-command])",
  );
  const item = document.createElement(template?.tagName.toLowerCase() ?? "div");
  if (template?.className) {
    item.className = template.className;
  }
  if (template?.hasAttribute("cmdk-item")) {
    item.setAttribute("cmdk-item", "");
  }

  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", "false");
  item.setAttribute("data-selected", "false");
  item.setAttribute("data-codexpp-slash-command", command.name);
  item.setAttribute("data-value", command.name);
  item.tabIndex = -1;

  const row = document.createElement("div");
  row.className = "codexpp-slash-command-row";

  const title = document.createElement("div");
  title.className = "codexpp-slash-command-title";
  title.textContent = `/${command.name}`;

  const description = document.createElement("div");
  description.className = "codexpp-slash-command-description";
  description.textContent = command.description ?? command.title;

  row.append(title, description);
  item.replaceChildren(row);
  return item;
}

function removeInjectedItems(root: ParentNode = document): void {
  root.querySelectorAll(COMMAND_ITEM_SELECTOR).forEach((item) => item.remove());
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [data-codexpp-slash-command] {
      box-sizing: border-box;
      cursor: pointer;
      min-height: 36px;
      padding: 6px 8px;
      width: 100%;
    }
    [data-codexpp-slash-command]:hover,
    [data-codexpp-slash-command][data-selected="true"] {
      background: var(--color-token-list-hover-background);
    }
    [data-codexpp-slash-command][data-disabled="true"] {
      cursor: default;
      opacity: 0.5;
      pointer-events: none;
    }
    .codexpp-slash-command-row {
      align-items: center;
      display: flex;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }
    .codexpp-slash-command-title {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codexpp-slash-command-description {
      color: var(--color-token-description-foreground, currentColor);
      flex: 1 1 auto;
      font-size: 0.875rem;
      margin-inline-start: auto;
      min-width: 0;
      opacity: 0.72;
      overflow: hidden;
      text-align: end;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}
