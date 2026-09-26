import { ipcRenderer } from "electron";

/** Core Config content, independent of installed tweaks. */
export function renderBackendSettings(root: HTMLElement): void {
  root.className = "flex flex-col gap-3 p-3 text-sm text-default";
  const status = document.createElement("p");
  const notice = document.createElement("p");
  notice.className = "text-secondary";
  notice.textContent = "Changes apply after you quit and reopen Codex-DC. Finish active tasks first.";

  const providerLabel = document.createElement("label");
  providerLabel.className = "flex items-center justify-between gap-3";
  providerLabel.append("CLI source");
  const provider = document.createElement("select");
  provider.className = "h-8 rounded-lg border border-default bg-surface px-2 text-sm text-default";
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
  providerLabel.append(provider);
  const updateLabel = document.createElement("label");
  const autoUpdate = document.createElement("input");
  autoUpdate.type = "checkbox";
  updateLabel.append(autoUpdate, " Automatically update the DC fork before launch");
  const updateHelp = document.createElement("p");
  updateHelp.className = "text-secondary";
  updateHelp.textContent = "Checks at most once per hour when the DC fork is selected. Running sessions are not restarted. Rollback turns automatic updates off.";

  const local = document.createElement("div");
  const pathLabel = document.createElement("label");
  pathLabel.className = "flex flex-col gap-2";
  pathLabel.append("Local CLI executable");
  const path = document.createElement("input");
  path.type = "text";
  path.spellcheck = false;
  path.className = "h-8 w-full rounded-lg border border-default bg-surface px-2 text-sm text-default";
  pathLabel.append(path);
  const help = document.createElement("p");
  help.className = "text-secondary";
  help.textContent = "Uses your executable directly, so local rebuilds remain linked.";
  local.append(pathLabel, help);

  const controls = document.createElement("div");
  controls.className = "flex flex-wrap gap-2";
  const output = document.createElement("p");
  output.setAttribute("role", "status");
  const refresh = async () => {
    const state = await ipcRenderer.invoke("codexdc:backend", "status");
    provider.value = state.provider;
    autoUpdate.checked = state.autoUpdate === true;
    path.value = state.development?.executable ?? "";
    status.textContent = `Saved: ${state.provider === "development" ? "Local path" : state.provider === "fork" ? "DC fork" : "Desktop bundled (stock)"}. ` +
      `Installed DC fork: ${state.installed?.version ?? "none"}. ` +
      `Running: ${state.activeExecutable ?? "desktop bundled"}.`;
    if (state.updateCheck?.error) status.textContent += ` Last CLI update failed: ${state.updateCheck.error}`;
    showLocal();
  };
  const setBusy = (busy: boolean) => {
    for (const control of Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"))) {
      control.disabled = busy;
    }
  };
  const add = (label: string, run: () => Promise<string>) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.type = "button";
    button.className = "inline-flex h-8 items-center rounded-lg border border-default px-2 text-sm text-default enabled:hover:bg-primary-ghost-hover focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
    button.onclick = async () => {
      setBusy(true);
      output.textContent = "Working…";
      try { output.textContent = await run(); }
      catch (error) { output.textContent = String(error); }
      finally { setBusy(false); }
    };
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
  autoUpdate.addEventListener("change", async () => {
    setBusy(true);
    try {
      await ipcRenderer.invoke("codexdc:backend", "auto-update", autoUpdate.checked ? "on" : "off");
      output.textContent = "CLI update preference saved.";
    } catch (error) { output.textContent = String(error); }
    finally {
      try { await refresh(); } catch (error) { output.textContent = String(error); }
      setBusy(false);
    }
  });
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
  root.append(status, providerLabel, local, updateLabel, updateHelp, notice, controls, output);
  showLocal();
  setBusy(true);
  void refresh().catch((error) => { output.textContent = String(error); }).finally(() => setBusy(false));
}
