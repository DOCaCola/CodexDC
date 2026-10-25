import { ipcRenderer } from "electron";
import {
  settingsDescriptionClass,
  settingsInputClass,
  settingsRow,
  settingsSelectClass,
  settingsSwitch,
  stockButton,
} from "./stock-settings-controls";

type Provider = "fork" | "bundled" | "development";
interface CliPackage { tag: string; releaseId: number; version: string; executable: string }
interface BackendStatus {
  provider: Provider;
  autoUpdate?: boolean;
  updateCheck?: { checkedAt: string; error?: string };
  installed?: CliPackage;
  previous?: CliPackage;
  development?: { executable: string; version: string };
  activeExecutable: string | null;
  activeVersion: string | null;
}

const providerLabels: Record<Provider, string> = {
  fork: "DC fork",
  bundled: "Desktop bundled",
  development: "Local executable",
};

function backend<T = BackendStatus>(action: string, arg?: string): Promise<T> {
  return ipcRenderer.invoke("codexdc:backend", action, ...(arg === undefined ? [] : [arg]));
}

const shortVersion = (version: string) => version.replace(/^codex-cli\s+/, "");
const errorText = (error: unknown) =>
  String(error).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, "");
// Rows and buttons use display utilities, which take precedence over the hidden attribute.
const reveal = (element: HTMLElement, shown: boolean) => { element.style.display = shown ? "" : "none"; };

/** The executable launch passes to the desktop for the saved selection. */
function savedExecutable(state: BackendStatus): string | null {
  if (state.provider === "fork") return state.installed?.executable ?? null;
  if (state.provider === "development") return state.development?.executable ?? null;
  return null;
}

/** Core Config content, independent of installed tweaks. Every control saves immediately. */
export function renderBackendSettings(root: HTMLElement): void {
  root.className = "flex flex-col divide-y divide-border text-sm text-default";
  let state: BackendStatus | null = null;
  // "Local executable" is chosen, but no executable has been saved yet.
  let draftLocal = false;

  const source = settingsRow("CLI source");
  const sourceInfo = document.createElement("div");
  sourceInfo.className = settingsDescriptionClass;
  sourceInfo.textContent = "Loading…";
  source.stack.appendChild(sourceInfo);
  const provider = document.createElement("select");
  provider.className = settingsSelectClass;
  provider.setAttribute("aria-label", "CLI source");
  for (const [value, label] of Object.entries(providerLabels)) provider.append(new Option(label, value));
  source.actions.appendChild(provider);

  const local = settingsRow("Local executable");
  local.row.className = "flex flex-col gap-2 px-4 py-3";
  const localInfo = document.createElement("div");
  localInfo.className = settingsDescriptionClass;
  local.stack.appendChild(localInfo);
  const localControls = document.createElement("div");
  localControls.className = "flex items-center gap-2";
  const path = document.createElement("input");
  path.type = "text";
  path.spellcheck = false;
  path.placeholder = "Path to a codex executable";
  path.className = settingsInputClass;
  path.setAttribute("aria-label", "Local executable");
  const browse = stockButton("Browse…", async () => {
    const selected = await backend<string | null>("browse");
    if (selected) { path.value = selected; void saveLocal(); }
  });
  localControls.append(path, browse);
  local.row.replaceChild(localControls, local.actions);

  const fork = settingsRow("DC fork");
  const forkInfo = document.createElement("div");
  forkInfo.className = settingsDescriptionClass;
  fork.stack.appendChild(forkInfo);
  const rollback = stockButton("", () => void run("Restoring the previous version…", async () => {
    await backend("rollback");
    return "Previous version restored. Automatic updates are now off so it stays in place.";
  }));
  const update = stockButton("Check for updates", () => void run("Checking for a new DC fork release…", async () => {
    const before = state?.installed?.releaseId;
    const next = await backend("update");
    const version = shortVersion(next.installed!.version);
    return next.installed!.releaseId === before ? `DC fork ${version} is up to date.` : `Installed DC fork ${version}.`;
  }));
  fork.actions.append(rollback, update);

  const auto = settingsRow(
    "Update automatically",
    "Installs new DC fork releases when Codex-DC starts, checking at most once an hour.",
  );
  const autoUpdate = settingsSwitch(false, (checked) => run("Saving…", async () => {
    await backend("auto-update", checked ? "on" : "off");
  }), "Update the DC fork automatically");
  auto.actions.appendChild(autoUpdate);

  const message = document.createElement("p");
  message.className = `${settingsDescriptionClass} px-4 py-3`;
  message.setAttribute("role", "status");
  const show = (text: string) => { message.textContent = text; reveal(message, !!text); };

  const render = () => {
    if (!state) return;
    const selected = draftLocal ? "development" : state.provider;
    provider.value = selected;
    const running = state.activeVersion ? `Running ${shortVersion(state.activeVersion)}.` : "Running version unavailable.";
    sourceInfo.textContent = savedExecutable(state) === state.activeExecutable
      ? running
      : `${running} Quit and reopen Codex-DC to apply the saved selection.`;

    reveal(local.row, selected === "development");
    if (!draftLocal) path.value = state.development?.executable ?? "";
    localInfo.textContent = state.development && !draftLocal
      ? shortVersion(state.development.version)
      : "Uses your build in place, so rebuilds apply on the next launch.";

    reveal(fork.row, selected === "fork");
    reveal(auto.row, selected === "fork");
    forkInfo.textContent = state.installed ? `Version ${shortVersion(state.installed.version)}` : "Not installed";
    if (state.updateCheck?.error) forkInfo.textContent += `. Last automatic update failed: ${state.updateCheck.error}`;
    reveal(rollback, !!state.previous);
    if (state.previous) rollback.textContent = `Use ${shortVersion(state.previous.version)}`;
    autoUpdate.setChecked(state.autoUpdate === true);
  };

  const setBusy = (busy: boolean) => {
    for (const control of Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"))) {
      control.disabled = busy;
    }
  };

  async function run(working: string, action?: () => Promise<string | void>): Promise<void> {
    setBusy(true);
    show(working);
    try { show((action ? await action() : undefined) ?? ""); }
    catch (error) { show(errorText(error)); }
    try { state = await backend("status"); render(); }
    catch (error) { show(errorText(error)); }
    setBusy(false);
  }

  function saveLocal(): Promise<void> {
    const executable = path.value.trim();
    if (!executable || (state?.provider === "development" && executable === state.development?.executable)) {
      return Promise.resolve();
    }
    return run("Checking the local executable…", async () => {
      await backend("develop", executable);
      draftLocal = false;
    });
  }
  path.addEventListener("change", () => void saveLocal());

  provider.addEventListener("change", () => {
    const next = provider.value as Provider;
    draftLocal = next === "development" && !state?.development;
    if (draftLocal) { render(); path.focus(); return; }
    void run(next === "fork" && !state?.installed ? "Installing the DC fork…" : "Saving…", async () => {
      await backend("select", next);
    });
  });

  for (const row of [local.row, fork.row, auto.row]) reveal(row, false);
  root.append(source.row, local.row, fork.row, auto.row, message);
  void run("");
}
