import { backendState, CLI_REPO, installBackend, type BackendState } from "./backend.js";
import { latestRelease } from "./releases.js";
import { userPaths } from "./paths.js";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const services = { latestRelease, installBackend, now: Date.now, report: console.warn };

function releaseVersion(tag: string): number[] {
  const match = /^doca-v(\d+)\.(\d+)\.(\d+)-doca(?:\.(\d+))?$/.exec(tag);
  if (!match) throw new Error(`Unrecognized fork release tag: ${tag}`);
  return match.slice(1).map((part) => Number(part ?? 0));
}

/** Update only an opted-in fork, before launching the desktop. */
export async function updateBackendBeforeLaunch(root = userPaths().root, deps = services): Promise<void> {
  const state = backendState(root);
  if (state.provider !== "fork" || state.autoUpdate !== true || !state.installed ||
      !existsSync(state.installed.executable)) return;
  const now = deps.now();
  if (state.updateCheck && now - Date.parse(state.updateCheck.checkedAt) < 60 * 60_000) return;
  const updateCheck: NonNullable<BackendState["updateCheck"]> = { checkedAt: new Date(now).toISOString() };
  try {
    const release = await deps.latestRelease(CLI_REPO);
    const current = releaseVersion(state.installed.tag);
    const candidate = releaseVersion(release.tag_name);
    const difference = candidate.map((part, index) => part - current[index]).find((part) => part !== 0) ?? 0;
    if (difference > 0) await deps.installBackend(root, release);
  } catch (error) {
    updateCheck.error = String(error);
    deps.report(`CLI update was not applied; keeping the installed backend: ${String(error)}`);
  }
  // Read again so installation and any saved selection are retained.
  const temp = join(root, `backend-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify({ ...backendState(root), updateCheck }, null, 2));
  renameSync(temp, join(root, "backend.json"));
}
