import { chmodSync } from "node:fs";
import { join } from "node:path";
import { compareSemver } from "../version.js";
import { readSelfUpdateState } from "../self-update-state.js";
export { updatePackage as selfUpdate } from "../package-update.js";
const WATCHER_SELF_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const COMMAND_OUTPUT_TAIL_CHARS = 8000;
export interface CommandResult { status: number; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }
export function shouldDownloadSelfUpdate(
  currentVersion: string,
  targetRef: string,
  force = false,
): boolean {
  if (force) return true;
  const targetVersion = releaseVersionFromTag(targetRef);
  if (!targetVersion) return true;
  return compareSemver(targetVersion, currentVersion) > 0;
}

export function shouldRunWatcherSelfUpdate(stateFile: string, now = Date.now()): boolean {
  const state = readSelfUpdateState(stateFile);
  if (!state) return true;
  const checkedAt = Date.parse(state.checkedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt >= WATCHER_SELF_UPDATE_INTERVAL_MS;
}

export function ensureCliExecutable(sourceRoot: string): void {
  if (process.platform === "win32") return;
  chmodSync(join(sourceRoot, "packages", "installer", "dist", "cli.js"), 0o755);
}

export function releaseVersionFromTag(ref: string): string | null {
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(ref) ? ref.replace(/^v/, "") : null;
}

export function resolveSelfUpdateRepo(
  optionRepo?: string,
  environmentRepo?: string,
  configRepo?: string,
): string | null {
  for (const candidate of [optionRepo, environmentRepo, configRepo]) {
    const repo = candidate?.trim();
    if (repo) return repo;
  }
  return null;
}

export function formatCommandFailure(command: string, args: string[], result: CommandResult): string {
  const status = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
  const details = result.error ? ` (${result.error.message})` : "";
  const output = commandOutputTail(result);
  return [
    `${formatCommand(command, args)} failed with ${status}${details}`,
    output ? `Command output:\n${output}` : null,
  ].filter(Boolean).join("\n\n");
}

function commandOutputTail(result: CommandResult): string {
  const parts = [
    ["stderr", result.stderr] as const,
    ["stdout", result.stdout] as const,
  ].flatMap(([name, value]) => {
    const text = value.trim();
    if (!text) return [];
    return [`${name}:\n${tail(text, COMMAND_OUTPUT_TAIL_CHARS)}`];
  });
  return parts.join("\n\n");
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[last ${maxChars} chars]\n${text.slice(-maxChars)}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuoteArg).join(" ");
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
