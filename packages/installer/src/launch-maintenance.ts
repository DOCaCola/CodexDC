import kleur from "kleur";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { desktopFingerprint } from "@codexdc/sdk/dist/desktop-fingerprint.js";
import type { InstallerState } from "./state.js";
import { ensureUserPaths } from "./paths.js";
import { readState } from "./state.js";
import { isCodexRunning } from "./alerts.js";
import { repair } from "./commands/repair.js";
import { updatePackage, UpdateRecoveryError, type UpdatedPackage } from "./package-update.js";
import { CODEXDC_VERSION } from "./version.js";
import { updateBackendBeforeLaunch } from "./backend-update.js";

const maintenance = {
  readInstall: () => readState(ensureUserPaths().stateFile),
  isRunning: isCodexRunning,
  update: () => updatePackage({ onLaunch: true }),
  repair: (force: boolean) => repair({ force }),
  updateBackend: updateBackendBeforeLaunch,
  needsRepair: (state: InstallerState) => managedStartupNeedsRepair(state),
  log: console.log,
  report: (error: unknown) => {
    const message = `Patcher update was not applied: ${String(error)}`;
    console.warn(kleur.yellow(message));
    appendFileSync(join(ensureUserPaths().logDir, "launch-update.log"), `${new Date().toISOString()} ${message}\n`);
  },
};

/** Runs once before starting the desktop. Returns a new package to hand off to. */
export async function maintainBeforeLaunch(
  checkForUpdate = true,
  services = maintenance,
): Promise<UpdatedPackage | undefined> {
  const state = services.readInstall();
  if (!state) throw new Error("Install CodexDC first.");
  if (services.isRunning(state.appRoot)) {
    services.log("CodexDC is already running; skipping update and repair checks.");
    return;
  }
  if (checkForUpdate) {
    try {
      const next = await services.update();
      if (next) return next;
    } catch (error) {
      if (error instanceof UpdateRecoveryError) throw error;
      services.report(error);
    }
  }
  await services.repair(services.needsRepair(state));
  await services.updateBackend();
}

export function managedStartupNeedsRepair(state: InstallerState): boolean {
  if (state.version !== CODEXDC_VERSION) return true;
  if (process.platform !== "win32") return false;
  const assets = fileURLToPath(new URL("../assets/", import.meta.url));
  const expected = desktopFingerprint(join(assets, "runtime"), readFileSync(join(assets, "loader.cjs")));
  try {
    const installedLoader = asar.extractFile(join(state.appRoot, "resources", "app.asar"), "codexdc-loader.cjs");
    return desktopFingerprint(ensureUserPaths().runtime, installedLoader) !== expected;
  } catch {
    return true; // Missing or incomplete installed startup code needs a full repair.
  }
}
