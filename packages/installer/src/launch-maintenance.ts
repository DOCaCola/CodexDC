import kleur from "kleur";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
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
  await services.repair(state.version !== CODEXDC_VERSION);
  await services.updateBackend();
}
