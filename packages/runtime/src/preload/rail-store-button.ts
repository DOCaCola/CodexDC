/**
 * Shows a Tweak Store button above the usage gauge in Codex's navigation rail
 * while installed tweaks have approved updates. Clicking it opens the Tweak
 * Store in Settings.
 */

import { openTweakStore, tweakStore } from "./settings-injector";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
// The rail's bottom column holds the usage gauge above the profile button.
const PROFILE_BUTTON = '[aria-label="Open profile menu"]';
// Button styling attributes the rail's buttons share.
const STYLE_ATTRIBUTES = ["class", "data-color", "data-variant", "data-squircle", "data-uniform", "data-size", "data-icon-size"];

let button: HTMLButtonElement | null = null;
let badge: HTMLSpanElement | null = null;
let count = 0;
let frame: number | null = null;

export function installRailStoreButton(): void {
  if (button) return;
  button = document.createElement("button");
  button.type = "button";
  button.dataset.codexppRailStore = "true";
  button.style.position = "relative";
  button.style.color = "var(--color-text-info)";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void openTweakStore();
  });
  badge = document.createElement("span");
  badge.className = "tabular-nums";
  badge.style.cssText =
    "position:absolute;top:1px;inset-inline-end:1px;min-width:16px;height:16px;padding:0 4px;" +
    "border-radius:9999px;background:var(--color-background-info-solid);color:var(--color-text-info-solid);" +
    "font-size:10px;font-weight:600;line-height:16px;text-align:center;pointer-events:none;";

  tweakStore.subscribe((next) => {
    count = next ?? 0;
    sync();
  });
  new MutationObserver(scheduleSync).observe(document.documentElement, { childList: true, subtree: true });
  const refresh = () => tweakStore.load(true).catch(() => {
    // The main process logs catalog failures; the button stays hidden meanwhile.
  });
  void refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

function scheduleSync(): void {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    sync();
  });
}

function sync(): void {
  if (!button || !badge) return;
  const profile = document.querySelector<HTMLElement>(PROFILE_BUTTON);
  const column = profile?.closest<HTMLElement>(".flex-col");
  if (count <= 0 || !profile || !column) {
    button.remove();
    return;
  }
  for (const name of STYLE_ATTRIBUTES) {
    const value = profile.getAttribute(name);
    if (value === null) button.removeAttribute(name);
    else if (button.getAttribute(name) !== value) button.setAttribute(name, value);
  }
  const label = count === 1 ? "1 tweak update available" : count + " tweak updates available";
  if (button.getAttribute("aria-label") !== label) {
    button.setAttribute("aria-label", label);
    button.title = label + " · Open Tweak Store";
    const inner = document.createElement("span");
    inner.className = profile.firstElementChild?.className ?? "";
    inner.innerHTML = storeIconSvg();
    badge.textContent = String(count);
    button.replaceChildren(inner, badge);
  }
  if (column.firstElementChild !== button) column.prepend(button);
}

function storeIconSvg(): string {
  return (
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M4 8.2 5.1 4.5A1.5 1.5 0 0 1 6.55 3.4h6.9a1.5 1.5 0 0 1 1.45 1.1L16 8.2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M4.5 8h11v7.5A1.5 1.5 0 0 1 14 17H6a1.5 1.5 0 0 1-1.5-1.5V8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M7.5 8v1a2.5 2.5 0 0 0 5 0V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    "</svg>"
  );
}
