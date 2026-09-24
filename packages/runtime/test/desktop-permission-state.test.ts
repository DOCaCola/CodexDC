import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileDesktopThreadPermissions } from "../src/desktop-permission-state";

test("normalizes stale desktop thread permissions when config requires full access", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, ".codex-global-state.json");
    const backupPath = `${statePath}.bak`;
    writeFileSync(
      configPath,
      [
        'sandbox_mode = "danger-full-access"',
        'approval_policy = "never"',
        'approvals_reviewer = "user"',
        "",
        "[shell_environment_policy.set]",
        'MSYSTEM = "UCRT64"',
      ].join("\n"),
    );
    const state = makeState({
      stale: {
        activePermissionProfile: null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
        },
      },
      current: {
        activePermissionProfile: null,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(backupPath, JSON.stringify(state));

    const result = reconcileDesktopThreadPermissions({
      codexConfigPath: configPath,
      statePaths: [statePath, backupPath],
    });

    assert.deepEqual(result, { filesUpdated: 2, threadsUpdated: 2 });
    for (const path of [statePath, backupPath]) {
      const updated = readPermissions(path);
      assert.deepEqual(updated.stale, {
        activePermissionProfile: null,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      assert.deepEqual(updated.current, {
        activePermissionProfile: null,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
    }
  });
});

test("leaves desktop permissions unchanged for managed sandbox config", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, ".codex-global-state.json");
    writeFileSync(
      configPath,
      ['sandbox_mode = "workspace-write"', 'approval_policy = "on-request"'].join("\n"),
    );
    const state = makeState({
      thread: {
        activePermissionProfile: null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
      },
    });
    const original = JSON.stringify(state);
    writeFileSync(statePath, original);

    const result = reconcileDesktopThreadPermissions({
      codexConfigPath: configPath,
      statePaths: [statePath],
    });

    assert.deepEqual(result, { filesUpdated: 0, threadsUpdated: 0 });
    assert.equal(readFileSync(statePath, "utf8"), original);
  });
});

function makeState(
  permissions: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return {
    unrelated: { preserved: true },
    "electron-persisted-atom-state": {
      "heartbeat-thread-permissions-by-id": permissions,
    },
  };
}

function readPermissions(path: string): Record<string, Record<string, unknown>> {
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    "electron-persisted-atom-state": {
      "heartbeat-thread-permissions-by-id": Record<string, Record<string, unknown>>;
    };
  };
  return state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"];
}

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codexpp-desktop-permissions-"));
  try {
    mkdirSync(root, { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
