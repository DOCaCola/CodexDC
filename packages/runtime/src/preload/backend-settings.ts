import { ipcRenderer } from "electron";
import {
  settingsDescriptionClass,
  settingsInputClass,
  settingsRow,
  settingsSelectClass,
  settingsSwitch,
  stockButton,
} from "./stock-settings-controls";

/** Core Config content, independent of installed tweaks. */
export function renderBackendSettings(root: HTMLElement): void {
  root.className = "flex flex-col divide-y divide-border text-sm text-default";
  const summary = settingsRow("Running CLI version");
  const status = document.createElement("p");
  status.className = settingsDescriptionClass;
  const runningVersion = document.createElement("p");
  runningVersion.className = "text-sm text-secondary tabular-nums";
  runningVersion.textContent = "Loading…";
  summary.stack.appendChild(status);
  summary.actions.appendChild(runningVersion);

  const providerRow = settingsRow(
    "CLI source",
    "Changes apply after you quit and reopen Codex-DC. Finish active tasks first.",
  );
  const provider = document.createElement("select");
  provider.className = settingsSelectClass;
  provider.setAttribute("aria-label", "CLI source");
  for (const [value, text] of [
    ["fork", "DC fork (default)"],
    ["bundled", "Desktop bundled (stock)"],
    ["development", "Local path"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    provider.append(option);
  }
  providerRow.actions.appendChild(provider);
  const updateRow = settingsRow(
    "Automatically update the DC fork",
    "Checks before launch, at most once per hour when the DC fork is selected. Running sessions are not restarted. Rollback turns automatic updates off.",
  );
  const autoUpdate = settingsSwitch(false, async (checked) => {
    setBusy(true);
    try {
      await ipcRenderer.invoke("codexdc:backend", "auto-update", checked ? "on" : "off");
      output.textContent = "CLI update preference saved.";
    } catch (error) { output.textContent = String(error); }
    finally {
      try { await refresh(); } catch (error) { output.textContent = String(error); }
      setBusy(false);
    }
  }, "Automatically update the DC fork");
  updateRow.actions.appendChild(autoUpdate);

  const local = settingsRow(
    "Local CLI executable",
    "Uses your executable directly, so local rebuilds remain linked.",
  ).row;
  local.className = "flex flex-col gap-2 px-4 py-3";
  const path = document.createElement("input");
  path.type = "text";
  path.spellcheck = false;
  path.className = settingsInputClass;
  path.setAttribute("aria-label", "Local CLI executable");
  local.appendChild(path);

  const controlsRow = document.createElement("div");
  controlsRow.className = "flex flex-col gap-3 px-4 py-3";
  const controls = document.createElement("div");
  controls.className = "flex flex-wrap gap-2";
  const output = document.createElement("p");
  output.className = settingsDescriptionClass;
  output.setAttribute("role", "status");
  controlsRow.append(controls, output);
  const refresh = async () => {
    const state = await ipcRenderer.invoke("codexdc:backend", "status");
    provider.value = state.provider;
    autoUpdate.setChecked(state.autoUpdate === true);
    path.value = state.development?.executable ?? "";
    status.textContent = `Saved: ${state.provider === "development" ? "Local path" : state.provider === "fork" ? "DC fork" : "Desktop bundled (stock)"}. ` +
      `Installed DC fork: ${state.installed?.version ?? "none"}. ` +
      `Running: ${state.activeExecutable ?? "desktop bundled"}.`;
    if (state.updateCheck?.error) status.textContent += ` Last CLI update failed: ${state.updateCheck.error}`;
    runningVersion.textContent = state.activeVersion ?? "Unavailable";
    showLocal();
  };
  const setBusy = (busy: boolean) => {
    for (const control of Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"))) {
      control.disabled = busy;
    }
  };
  const add = (label: string, run: () => Promise<string>) => {
    const button = stockButton(label, async () => {
      setBusy(true);
      output.textContent = "Working…";
      try { output.textContent = await run(); }
      catch (error) { output.textContent = String(error); }
      finally { setBusy(false); }
    });
    controls.append(button);
    return button;
  };
  const browse = add("Browse…", async () => {
    const selected = await ipcRenderer.invoke("codexdc:backend", "browse");
    if (selected) path.value = selected;
    return "Choose Save CLI selection to apply the local path.";
  });
  const showLocal = () => {
    local.hidden = provider.value !== "development";
    browse.hidden = local.hidden;
  };
  provider.addEventListener("change", showLocal);
  add("Save CLI selection", async () => {
    if (provider.value === "development") {
      await ipcRenderer.invoke("codexdc:backend", "develop", path.value.trim());
    } else {
      output.textContent = provider.value === "fork" ? "Preparing the DC fork package…" : "Saving…";
      await ipcRenderer.invoke("codexdc:backend", "select", provider.value);
    }
    await refresh();
    return "Selection saved. Quit and reopen Codex-DC to apply.";
  });
  add("Check latest release", async () => {
    const result = await ipcRenderer.invoke("codexdc:backend", "check");
    return `Latest DC fork release: ${result.tag}`;
  });
  add("Install / update DC fork", async () => {
    output.textContent = "Downloading and validating the complete CLI package…";
    await ipcRenderer.invoke("codexdc:backend", "install");
    await refresh();
    return "DC fork installed. Your saved CLI selection is unchanged.";
  });
  add("Previous DC fork version", async () => {
    await ipcRenderer.invoke("codexdc:backend", "rollback");
    await refresh();
    return "Previous DC fork version restored. Quit and reopen Codex-DC to apply.";
  });
  root.append(summary.row, providerRow.row, local, updateRow.row, controlsRow);
  showLocal();
  setBusy(true);
  void refresh().catch((error) => { output.textContent = String(error); }).finally(() => setBusy(false));
}
