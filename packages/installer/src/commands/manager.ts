import prompts from "prompts";
import { selfUpdate } from "./self-update.js";
import { execFileSync } from "node:child_process";
import { install } from "./install.js";
import { repair } from "./repair.js";
import { uninstall } from "./uninstall.js";
import { safeMode } from "./safe-mode.js";
import { installManagedMac, uninstallManagedMac } from "../managed-mac.js";
import { launchManaged } from "../launch.js";
import { backendState, checkBackend, installBackend, selectBackend, rollbackBackend, configureDevelopmentBackend } from "../backend.js";
import { userPaths } from "../paths.js";
import { updateCodex } from "./update-codex.js";

export async function manager(): Promise<void> {
  while (true) {
    const { action } = await prompts({
      type: "select", name: "action", message: "CodexDC Setup",
      choices: [
        { title: "Install a separate patched desktop", value: "install" },
        { title: "Launch CodexDC", value: "launch" },
        { title: "Update CodexDC", value: "update" },
        { title: "Repair / refresh desktop copy", value: "repair" },
        { title: "Choose Codex CLI backend", value: "backend" },
        { title: "Open official Codex for updating (macOS)", value: "official" },
        { title: "Enable safe mode", value: "safe" },
        { title: "Disable safe mode", value: "normal" },
        { title: "Open logs", value: "logs" },
        { title: "Uninstall CodexDC", value: "uninstall" },
        { title: "Exit", value: "exit" },
      ],
    });
    if (!action || action === "exit") return;
    try {
      switch (action) {
        case "install":
          if (process.platform === "darwin") await installManagedMac();
          else await install();
          console.log("Choose optional tweaks from the Tweak Store in CodexDC Settings.");
          break;
        case "launch": await launchManaged(); break;
        case "update":
          await selfUpdate();
          console.log("Reopen Setup to continue with the selected maintenance package.");
          return;
        case "repair": await repair({ force: true }); break;
        case "official": await updateCodex(); break;
        case "safe": safeMode({ on: true }); break;
        case "normal": safeMode({ off: true }); break;
        case "logs":
          execFileSync(process.platform === "win32" ? "explorer.exe" : "open", [userPaths().logDir]); break;
        case "uninstall": {
          const { confirmed } = await prompts({ type: "confirm", name: "confirmed",
            message: "Remove the CodexDC managed app? Your settings will remain.", initial: false });
          if (confirmed) {
            if (process.platform === "darwin") uninstallManagedMac();
            else await uninstall();
          }
          break;
        }
        case "backend": {
          console.log(JSON.stringify(backendState(), null, 2));
          const { choice } = await prompts({ type: "select", name: "choice", message: "Codex CLI",
            choices: [
              { title: "Desktop bundled", value: "bundled" },
              { title: "Install latest DC fork and select it", value: "install" },
              { title: "Use installed DC fork", value: "fork" },
              { title: "Use a local development CLI", value: "development" },
              { title: "Check latest release", value: "check" },
              { title: "Previous installed DC fork", value: "rollback" },
              { title: "Back", value: "back" },
            ] });
          if (choice === "install") { await installBackend(); selectBackend("fork"); }
          else if (choice === "fork" || choice === "bundled") selectBackend(choice);
          else if (choice === "development") {
            const { executable } = await prompts({ type: "text", name: "executable",
              message: "Development CLI executable path",
              initial: backendState().development?.executable ?? process.env.CODEX_CLI_PATH ?? "" });
            if (executable) await configureDevelopmentBackend(executable);
          }
          else if (choice === "check") console.log(await checkBackend());
          else if (choice === "rollback") rollbackBackend();
          console.log("Saved selection applies when you quit and reopen CodexDC. Finish active tasks first.");
        }
      }
    } catch (error) { console.error(error instanceof Error ? error.message : error); }
  }
}
