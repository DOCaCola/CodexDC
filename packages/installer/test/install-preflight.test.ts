import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCodexNotRunning,
  prepareCodexForPatching,
  preflightWritableTargets,
} from "../src/commands/install";
import type { OpenReport } from "../src/commands/debug";
import type { CodexInstall } from "../src/platform";

test("macOS ASAR integrity preflight needs the plist, no framework binary", () => {
  withTempDir((root) => {
    const resourcesDir = join(root, "Contents", "Resources");
    mkdirSync(resourcesDir, { recursive: true });
    const asarPath = join(resourcesDir, "app.asar");
    const metaPath = join(root, "Contents", "Info.plist");
    writeFileSync(asarPath, "");
    writeFileSync(metaPath, "");
    preflightWritableTargets({ resourcesDir, asarPath, metaPath,
      executable: join(root, "Codex"), platform: "darwin",
    }, { integrityUpdate: true });
  });
});

test("Windows ASAR integrity preflight requires the executable", () => {
  withTempDir((root) => {
    const asarPath = join(root, "app.asar");
    writeFileSync(asarPath, "");
    assert.throws(() => preflightWritableTargets({ resourcesDir: root, asarPath,
      metaPath: null, executable: join(root, "missing.exe"), platform: "win32",
    }, { integrityUpdate: true }), /ENOENT/);
  });
});

test("install preflight checks Info.plist before patching", { skip: process.platform === "win32" }, () => {
  withTempDir((root) => {
    const resourcesDir = join(root, "Contents", "Resources");
    mkdirSync(resourcesDir, { recursive: true });

    const asarPath = join(resourcesDir, "app.asar");
    const metaPath = join(root, "Contents", "Info.plist");
    writeFileSync(asarPath, "");
    writeFileSync(metaPath, "");
    chmodSync(metaPath, 0o444);

    try {
      let error: unknown;
      assert.throws(
        () => {
          try {
            preflightWritableTargets(
              {
                resourcesDir,
                asarPath,
                metaPath,
                executable: join(root, "app"),
                platform: "darwin",
              },
              { integrityUpdate: true },
            );
          } catch (e) {
            error = e;
            throw e;
          }
        },
        /Cannot write to .*Info\.plist/,
      );
      assert.match(String(error), /codexdc repair/);
    } finally {
      chmodSync(metaPath, 0o644);
    }
  });
});

test("install preflight allows patching when Codex is closed", () => {
  assert.doesNotThrow(() => {
    assertCodexNotRunning(fakeCodex(), {
      status: "closed",
      pid: null,
      relatedPids: [],
      openedAt: null,
      openedAtRaw: null,
      detail: null,
    });
  });
});

test("install preflight ignores helper-only Codex processes", () => {
  const helperOnly = {
    status: "background",
    pid: 123,
    relatedPids: [123, 456],
    hasMainProcess: false,
    openedAt: "2026-05-23T09:17:22.000Z",
    openedAtRaw: null,
    detail: "Only helper/background processes were found.",
  } satisfies OpenReport;

  assert.doesNotThrow(() => {
    assertCodexNotRunning(fakeCodex(), helperOnly);
  });

  assert.equal(
    prepareCodexForPatching(fakeCodex(), {
      getOpenReport: () => helperOnly,
    }),
    false,
  );
});

test("install preflight blocks patching while Codex is running", () => {
  assert.throws(
    () => {
      assertCodexNotRunning(fakeCodex(), {
        status: "inactive",
        pid: 123,
        relatedPids: [123, 456],
        openedAt: "2026-05-31T11:35:54.000Z",
        openedAtRaw: null,
        detail: "Main Codex process is running but not frontmost.",
      } satisfies OpenReport);
    },
    /Close Codex before patching[\s\S]*Changing the bundle underneath an active process/,
  );
});

test("install preflight restarts a running macOS Codex before patching", () => {
  const reports: OpenReport[] = [
    {
      status: "inactive",
      pid: 123,
      relatedPids: [123, 456],
      openedAt: "2026-05-31T11:35:54.000Z",
      openedAtRaw: null,
      detail: "Main Codex process is running but not frontmost.",
    },
    {
      status: "closed",
      pid: null,
      relatedPids: [],
      openedAt: null,
      openedAtRaw: null,
      detail: null,
    },
  ];
  let prompted = false;
  let reportIndex = 0;

  const shouldReopen = prepareCodexForPatching(fakeCodex(), {
    getOpenReport: () => reports[Math.min(reportIndex++, reports.length - 1)]!,
    quitCodex: () => {
      prompted = true;
    },
  });

  assert.equal(prompted, true);
  assert.equal(shouldReopen, true);
});

test("install preflight fails if Codex does not quit for restart patching", () => {
  assert.throws(
    () => {
      prepareCodexForPatching(fakeCodex(), {
        getOpenReport: () => ({
          status: "inactive",
          pid: 123,
          relatedPids: [123],
          openedAt: "2026-05-31T11:35:54.000Z",
          openedAtRaw: null,
          detail: "Main Codex process is running but not frontmost.",
        }),
        quitCodex: () => {},
      });
    },
    /Close Codex before patching/,
  );
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codexpp-install-preflight-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeCodex(): CodexInstall {
  return {
    appRoot: "/Applications/Codex.app",
    resourcesDir: "/Applications/Codex.app/Contents/Resources",
    asarPath: "/Applications/Codex.app/Contents/Resources/app.asar",
    metaPath: "/Applications/Codex.app/Contents/Info.plist",
    executable: "/Applications/Codex.app/Contents/MacOS/Codex",
    appName: "Codex",
    bundleId: "com.openai.codex",
    channel: "stable",
    platform: "darwin",
  };
}
