#!/usr/bin/env node
import sade from "sade";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findSourceRoot } from "./source-root.js";
import { forwardToActivePackage } from "./active-package.js";
import { manager } from "./commands/manager.js";
import { backendState, checkBackend, installBackend, selectAvailableBackend, rollbackBackend, configureDevelopmentBackend } from "./backend.js";
import { launchManaged } from "./launch.js";
import { installManagedMac, uninstallManagedMac } from "./managed-mac.js";
import kleur from "kleur";
import { install } from "./commands/install.js";
import { uninstall } from "./commands/uninstall.js";
import { repair } from "./commands/repair.js";
import { repairAfterExit } from "./commands/repair-after-exit.js";
import { updateCodex } from "./commands/update-codex.js";
import { selfUpdate } from "./commands/self-update.js";
import { status } from "./commands/status.js";
import { debug } from "./commands/debug.js";
import { browserUi } from "./commands/browser-ui.js";
import { doctor } from "./commands/doctor.js";
import { safeMode } from "./commands/safe-mode.js";
import { CODEXDC_VERSION } from "./version.js";
import { buildCliFailureIssueUrl, showPatchFailedAlert } from "./alerts.js";
import { capKnownLogFiles } from "./logging.js";

interface InstallCliOpts {
  app?: string;
  fuse?: boolean;
  resign?: boolean;
  local?: boolean;
  localSigning?: boolean;
  "local-signing"?: boolean;
  verbose?: boolean;
}

interface RepairCliOpts {
  app?: string;
  quiet?: boolean;
  force?: boolean;
  local?: boolean;
  localSigning?: boolean;
  "local-signing"?: boolean;
}

function wrap<T extends (...args: never[]) => unknown | Promise<unknown>>(fn: T): T {
  return ((...args: Parameters<T>) => {
    Promise.resolve()
      .then(() => fn(...args))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        const command = process.argv[2];
        console.error("\n" + kleur.red().bold("✗ codexdc failed"));
        console.error(msg);
        console.error("");
        console.error(
          kleur.yellow("If the message above does not explain how to fix it, please report this on GitHub:"),
        );
        console.error(buildCliFailureIssueUrl(command, msg));
        maybeShowPatchFailedAlert(msg);
        process.exit(1);
      });
  }) as unknown as T;
}

function runInstall(opts: InstallCliOpts): Promise<void> {
  if (process.platform === "darwin") return installManagedMac(opts);
  return install({
    ...opts,
    localSigning: resolveLocalSigning(opts),
  });
}

function runRepair(opts: RepairCliOpts): Promise<void> {
  return repair({
    ...opts,
    localSigning: resolveLocalSigning(opts),
  });
}

function resolveLocalSigning(opts: {
  local?: boolean;
  localSigning?: boolean;
  "local-signing"?: boolean;
}): boolean | undefined {
  if (opts.local === false || opts.localSigning === false || opts["local-signing"] === false) {
    return false;
  }
  return opts.localSigning ?? opts["local-signing"] ?? opts.local;
}

async function runCreateTweak(target: string, opts: never): Promise<void> {
  const { createTweak } = await import("./commands/create-tweak.js");
  return createTweak(target, opts);
}

async function runValidateTweak(target?: string): Promise<void> {
  const { validateTweak } = await import("./commands/validate-tweak.js");
  return validateTweak(target);
}

async function runDevTweak(target: string | undefined, opts: never): Promise<void> {
  const { devTweak } = await import("./commands/dev-tweak.js");
  return devTweak(target, opts);
}

function maybeShowPatchFailedAlert(message: string): void {
  const command = process.argv[2];
  if (command !== "repair") return;
  showPatchFailedAlert(message);
}

forwardToActivePackage(findSourceRoot(dirname(fileURLToPath(import.meta.url))));

const prog = sade("codexdc")
  .version(CODEXDC_VERSION)
  .describe("Tweak system for the Codex desktop app");

capKnownLogFiles();

prog
  .command("install")
  .describe("Install a separate managed CodexDC app")
  .option("--app", "Path to Codex.app / install dir (auto-detected if omitted)")
  .option("--fuse", "Flip Electron's embedded asar integrity fuse", true)
  .option("--resign", "Code sign Codex.app on macOS", true)
  .option("--local", "Use a stable local signing identity on macOS")
  .option("--local-signing", "Alias for --local")
  .option("--verbose", "Show low-level patching details")
  .action(wrap(runInstall));

prog
  .command("uninstall")
  .describe("Remove the managed CodexDC app")
  .option("--app", "Path to Codex.app / install dir")
  .option("--purge", "Delete tweaks, config, logs, backups, and CodexDC user data")
  .action(wrap(async (opts: { purge?: boolean }) => process.platform === "darwin" ? uninstallManagedMac() : uninstall(opts)));

prog
  .command("repair")
  .describe("Refresh the managed copy from official Codex")
  .option("--app", "Path to Codex.app / install dir")
  .option("--quiet", "Suppress non-error output")
  .option("--force", "Re-apply even if the patch appears intact")
  .option("--local", "Use a stable local signing identity on macOS")
  .option("--local-signing", "Alias for --local")
  .action(wrap(runRepair));

prog
  .command("repair-after-exit")
  .describe("Wait for CodexDC to exit, optionally update its Store package, repair, and relaunch")
  .option("--pid", "CodexDC main process id to wait for")
  .option("--store-family", "Store package family to update after CodexDC exits")
  .option("--store-version", "Store package version currently mirrored by CodexDC")
  .action(wrap(repairAfterExit));

prog
  .command("update-codex")
  .describe("Open official Codex for updating on macOS")
  .option("--app", "Path to Codex.app / install dir")
  .action(wrap(updateCodex));

prog
  .command("update")
  .describe("Install the latest stable CodexDC maintenance package")
  .option("--repo", "GitHub repo to download; omit to keep the current local source")
  .option("--ref", "Git ref to download (default: latest GitHub release)")
  .option("--quiet", "Suppress non-error output")
  .option("--force", "Download a release package even if the selected release is already installed")
  .action(wrap(selfUpdate));

prog
  .command("self-update")
  .describe("Alias for update")
  .option("--repo", "GitHub repo to download; omit to keep the current local source")
  .option("--ref", "Git ref to download (default: latest GitHub release)")
  .option("--quiet", "Suppress non-error output")
  .option("--force", "Download a release package even if the selected release is already installed")
  .action(wrap(selfUpdate));

prog
  .command("status")
  .describe("Show patch status, paths, version")
  .action(status);

prog
  .command("debug")
  .describe("Show Codex install, runtime, data paths, and open state")
  .option("--app", "Path to Codex.app / install dir")
  .action(wrap(debug));

prog
  .command("browser")
  .describe("Open the Codex React UI in a browser tab backed by a hidden Codex host")
  .option("--app", "Path to Codex.app / install dir")
  .option("--port", "Local browser UI port", 8765)
  .option("--open", "Open the browser tab after launch", true)
  .option("--keep-window", "Leave the Codex desktop window visible")
  .action(wrap(browserUi));

prog
  .command("doctor")
  .describe("Diagnose common issues (signature, fuses, asar integrity, perms)")
  .action(doctor);

prog
  .command("create-tweak <target>")
  .describe("Scaffold a new local tweak")
  .option("--id", "Manifest id, e.g. com.you.my-tweak")
  .option("--name", "Human-readable tweak name")
  .option("--repo", "GitHub repo in owner/repo form")
  .option("--scope", "renderer, main, or both")
  .option("--force", "Write into an existing empty directory")
  .action(wrap(runCreateTweak));

prog
  .command("validate-tweak [target]")
  .describe("Validate a tweak manifest and entry point")
  .action(wrap(runValidateTweak));

prog
  .command("dev [target]")
  .describe("Link a tweak into the CodexDC tweaks directory for local development")
  .option("--name", "Override linked directory name; defaults to manifest id")
  .option("--replace", "Replace an existing symlink at the target tweak id")
  .option("--watch", "Watch linked source for changes; --no-watch links once and exits", true)
  .action(wrap(runDevTweak));

prog
  .command("safe-mode")
  .describe("Temporarily disable all tweaks without deleting them. Leave safe mode with: codexdc safe-mode --off")
  .option("--on", "Enable safe mode (default)")
  .option("--off", "Disable safe mode and return to normal tweak loading")
  .option("--status", "Print current safe mode status")
  .action(wrap(safeMode));

prog.command("setup").describe("Open guided setup and maintenance").action(wrap(manager));
prog.command("launch").describe("Launch CodexDC with its selected CLI backend").action(wrap(launchManaged));
prog.command("backend <action> [provider]").describe("CLI backend: status, check, install, select bundled|fork|development, develop <executable>, rollback")
  .action(wrap(async (action: string, provider?: string) => {
    let result: unknown;
    switch (action) {
      case "status": result = backendState(); break;
      case "check": result = await checkBackend(); break;
      case "install": result = await installBackend(); break;
      case "select": result = await selectAvailableBackend(provider ?? ""); break;
      case "develop": result = await configureDevelopmentBackend(provider ?? ""); break;
      case "rollback": result = rollbackBackend(); break;
      default: throw new Error("Unknown backend action");
    }
    console.log(JSON.stringify(result));
  }));

const argv = process.argv.length <= 2 ? [...process.argv, "--help"] : process.argv;

prog.parse(argv, {
  unknown: (flag) => {
    console.error(kleur.red(`Unknown flag: ${flag}`));
    process.exit(1);
  },
});
