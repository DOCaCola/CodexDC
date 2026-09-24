import { ipcRenderer } from "electron";
import { registerSection } from "./settings-injector";

export function mountBackendSettings(): void {
  registerSection({
    id: "codexdc:backend",
    title: "Codex CLI",
    description: "Choose the desktop-bundled backend or the DOCaCola CLI fork.",
    render(root) {
      root.style.cssText = "display:flex;flex-direction:column;gap:12px";
      const status = document.createElement("p");
      const notice = document.createElement("p");
      notice.textContent = "Switching takes effect after you quit and reopen CodexDC. Finish active tasks first.";
      const controls = document.createElement("div");
      controls.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
      const output = document.createElement("p");
      output.setAttribute("role", "status");
      const refresh = async () => {
        const state = await ipcRenderer.invoke("codexdc:backend", "status");
        status.textContent = `Selected: ${state.provider === "fork" ? "DOCaCola fork" : "Desktop bundled"}. ` +
          `Installed fork: ${state.installed?.version ?? "none"}. ` +
          `Running: ${state.activeExecutable ? "fork — " + state.activeExecutable : "desktop bundled"}.`;
      };
      const add = (label: string, action: string, provider?: string) => {
        const button = document.createElement("button");
        button.textContent = label;
        button.style.cssText = "padding:8px;border:1px solid #777;border-radius:6px";
        button.onclick = async () => {
          const buttons = Array.from(controls.querySelectorAll("button"));
          buttons.forEach((b) => b.disabled = true);
          output.textContent = action === "install" ? "Downloading and validating the complete CLI package…" : "Working…";
          try {
            const result = await ipcRenderer.invoke("codexdc:backend", action, provider);
            output.textContent = action === "check" ? `Latest release: ${result.tag}` :
              action === "install" ? "Fork installed. Choose Use fork to activate it on next launch." :
              "Selection saved. Quit and reopen CodexDC to apply.";
            await refresh();
          } catch (error) { output.textContent = String(error); }
          finally { buttons.forEach((b) => b.disabled = false); }
        };
        controls.append(button);
      };
      add("Use desktop bundled", "select", "bundled");
      add("Use fork", "select", "fork");
      add("Check latest release", "check");
      add("Install / update fork", "install");
      add("Previous fork version", "rollback");
      root.append(status, notice, controls, output);
      void refresh().catch((error) => { output.textContent = String(error); });
    },
  });
}
