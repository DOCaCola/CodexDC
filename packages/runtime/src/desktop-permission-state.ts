import { existsSync, readFileSync, writeFileSync } from "node:fs";

type LogLevel = "info" | "warn";
type LogFn = (level: LogLevel, message: string, details?: unknown) => void;

interface ReconcileOptions {
  codexConfigPath: string;
  statePaths: string[];
  log?: LogFn;
}

interface PermissionEntry {
  activePermissionProfile?: unknown;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
  [key: string]: unknown;
}

interface GlobalState {
  "electron-persisted-atom-state"?: {
    "heartbeat-thread-permissions-by-id"?: Record<string, PermissionEntry>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface FullAccessConfig {
  approvalPolicy: "never";
  approvalsReviewer: string;
  sandboxMode: "danger-full-access";
}

export interface ReconcileDesktopPermissionResult {
  filesUpdated: number;
  threadsUpdated: number;
}

export function reconcileDesktopThreadPermissions(
  options: ReconcileOptions,
): ReconcileDesktopPermissionResult {
  const config = readFullAccessConfig(options.codexConfigPath);
  if (!config) return { filesUpdated: 0, threadsUpdated: 0 };

  let filesUpdated = 0;
  let threadsUpdated = 0;

  for (const statePath of options.statePaths) {
    if (!existsSync(statePath)) continue;

    let state: GlobalState;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8")) as GlobalState;
    } catch (error) {
      options.log?.("warn", "Failed to read Codex desktop permission state", {
        path: statePath,
        error: String((error as Error).message),
      });
      continue;
    }

    const permissions =
      state["electron-persisted-atom-state"]?.["heartbeat-thread-permissions-by-id"];
    if (!permissions || typeof permissions !== "object") continue;

    let fileChanged = false;
    for (const entry of Object.values(permissions)) {
      if (!entry || typeof entry !== "object") continue;
      if (isFullAccessEntry(entry, config.approvalsReviewer)) continue;

      entry.activePermissionProfile = null;
      entry.approvalPolicy = "never";
      entry.approvalsReviewer = config.approvalsReviewer;
      entry.sandboxPolicy = { type: "dangerFullAccess" };
      fileChanged = true;
      threadsUpdated += 1;
    }

    if (!fileChanged) continue;
    try {
      writeFileSync(statePath, JSON.stringify(state), "utf8");
      filesUpdated += 1;
    } catch (error) {
      options.log?.("warn", "Failed to update Codex desktop permission state", {
        path: statePath,
        error: String((error as Error).message),
      });
    }
  }

  if (filesUpdated > 0) {
    options.log?.("info", "Reconciled Codex desktop thread permissions", {
      filesUpdated,
      threadsUpdated,
      approvalPolicy: config.approvalPolicy,
      sandboxMode: config.sandboxMode,
    });
  }

  return { filesUpdated, threadsUpdated };
}

function readFullAccessConfig(configPath: string): FullAccessConfig | null {
  if (!existsSync(configPath)) return null;

  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  const values: Record<string, string> = {};
  let inRootSection = true;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (/^\[/.test(line)) {
      inRootSection = false;
      continue;
    }
    if (!inRootSection) continue;

    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const value = parseQuotedTomlString(match[2] ?? "");
    if (value != null) values[match[1] ?? ""] = value;
  }

  if (values.approval_policy !== "never") return null;
  if (values.sandbox_mode !== "danger-full-access") return null;

  return {
    approvalPolicy: "never",
    approvalsReviewer: values.approvals_reviewer || "user",
    sandboxMode: "danger-full-access",
  };
}

function stripTomlComment(line: string): string {
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function parseQuotedTomlString(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;

  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function isFullAccessEntry(entry: PermissionEntry, approvalsReviewer: string): boolean {
  const sandboxPolicy = entry.sandboxPolicy as { type?: unknown } | null | undefined;
  return (
    entry.activePermissionProfile == null &&
    entry.approvalPolicy === "never" &&
    entry.approvalsReviewer === approvalsReviewer &&
    sandboxPolicy?.type === "dangerFullAccess"
  );
}
