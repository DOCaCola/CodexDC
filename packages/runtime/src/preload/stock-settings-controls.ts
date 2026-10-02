/**
 * DOM equivalents of the desktop's Button, SettingsRow and Switch primitives.
 * Use the stock utility classes and semantic tokens so themes and density work
 * the same way in Codex-DC pages as they do in native settings.
 */
export const settingsRowClass =
  "@container/settings-row flex items-center justify-between gap-6 px-4 py-3";
export const settingsLabelClass = "min-w-0 break-words text-sm font-medium text-default";
export const settingsDescriptionClass =
  "min-w-0 text-xs leading-4 text-wrap break-words text-secondary";
export const settingsActionsClass =
  "flex max-w-full shrink-0 items-center justify-end gap-2 min-w-[min(--spacing(40),40cqw)] empty:min-w-0";
export const settingsSelectClass =
  "no-drag h-9 rounded-md border border-default bg-surface px-2 py-1 text-sm leading-none text-default focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
export const settingsInputClass =
  "min-w-0 w-full rounded-md border border-default bg-transparent px-3 py-2 text-sm text-default placeholder:text-tertiary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";
export const metadataBadgeClass =
  "inline-flex shrink-0 items-center gap-1 rounded-md bg-text/5 px-2 py-0.5 text-xs text-secondary";

const buttonColors = {
  primary: "border-default bg-primary-solid text-primary-solid not-disabled:not-aria-disabled:hover:bg-text/80 data-[state=open]:bg-text/80",
  secondary: "border-transparent bg-text/5 text-default not-disabled:not-aria-disabled:hover:bg-text/10 data-[state=open]:bg-text/10",
  ghost: "border-transparent text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover",
  outline: "border-default bg-transparent text-default not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover",
};
const buttonSizes = {
  settings: "h-7 rounded-button-action px-2 py-0 text-base leading-5",
  toolbar: "button-toolbar rounded-button-toolbar py-0 text-sm leading-[18px]",
  compact: "h-6 rounded-button-action px-2 py-0 text-xs leading-4",
  page: "h-8 shrink-0 rounded-full px-4 py-0 text-sm font-medium browser:h-9",
  dialog: "min-h-9 rounded-full px-3 text-sm font-medium",
};

export function stockButtonClass(
  color: keyof typeof buttonColors = "secondary",
  size: keyof typeof buttonSizes = "settings",
): string {
  return [
    "no-drag cursor-interaction flex items-center select-none whitespace-nowrap border gap-1",
    "disabled:cursor-default aria-disabled:cursor-default disabled:opacity-40 aria-disabled:opacity-40",
    "focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
    buttonColors[color], buttonSizes[size],
  ].join(" ");
}

export function stockButton(
  label: string,
  onClick: () => void,
  color: keyof typeof buttonColors = "secondary",
  size: keyof typeof buttonSizes = "settings",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = stockButtonClass(color, size);
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function settingsRow(title?: string, description?: string): {
  row: HTMLElement;
  stack: HTMLElement;
  actions: HTMLElement;
} {
  const row = document.createElement("div");
  row.className = settingsRowClass;
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-1 items-center gap-3";
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-1";
  if (title) {
    const label = document.createElement("div");
    label.className = settingsLabelClass;
    label.textContent = title;
    stack.appendChild(label);
  }
  if (description) {
    const help = document.createElement("div");
    help.className = settingsDescriptionClass;
    help.textContent = description;
    stack.appendChild(help);
  }
  left.appendChild(stack);
  const actions = document.createElement("div");
  actions.className = settingsActionsClass;
  actions.dataset.codexppRowActions = "true";
  row.append(left, actions);
  return { row, stack, actions };
}

export interface SettingsSwitch extends HTMLButtonElement {
  setChecked(checked: boolean): void;
}

export function settingsSwitch(
  initial: boolean,
  onChange: (next: boolean) => void | Promise<void>,
  label?: string,
): SettingsSwitch {
  const button = document.createElement("button") as SettingsSwitch;
  button.type = "button";
  button.setAttribute("role", "switch");
  if (label) button.setAttribute("aria-label", label);
  button.className =
    "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-full cursor-interaction disabled:cursor-not-allowed disabled:opacity-60";
  const track = document.createElement("span");
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("span");
  thumb.className =
    "rounded-full border border-control-thumb-on-accent bg-control-thumb-on-accent shadow-sm transition-transform duration-basic ease-out h-4 w-4 data-[state=unchecked]:translate-x-[2px] data-[state=checked]:translate-x-[14px] rtl:data-[state=unchecked]:-translate-x-[2px] rtl:data-[state=checked]:-translate-x-[14px]";
  track.appendChild(thumb);
  button.appendChild(track);
  button.setChecked = (checked) => {
    const state = checked ? "checked" : "unchecked";
    button.setAttribute("aria-checked", String(checked));
    button.dataset.state = track.dataset.state = thumb.dataset.state = state;
    track.className = `relative inline-flex shrink-0 items-center rounded-full transition-colors duration-basic ease-out h-5 w-8 ${checked ? "bg-chart-blue" : "bg-text/10"}`;
  };
  button.setChecked(initial);
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = button.getAttribute("aria-checked") !== "true";
    button.setChecked(next);
    button.disabled = true;
    try {
      await onChange(next);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
