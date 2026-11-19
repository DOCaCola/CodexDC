import { app, ipcMain } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { savedBackendEnvironment } from "@codexdc/sdk/dist/backend-selection.js";
import { installWindowsRestartPolicy } from "./windows-restart-policy";
import { desktopFingerprint } from "@codexdc/sdk/dist/desktop-fingerprint.js";

export function prepareDesktop(userRoot: string): void {
  const env = savedBackendEnvironment(userRoot, process.env);
  if (env.CODEX_CLI_PATH) process.env.CODEX_CLI_PATH = env.CODEX_CLI_PATH;
  else delete process.env.CODEX_CLI_PATH;
  const runtime = join(userRoot, "runtime");
  const policy = require(join(runtime, "native", "codexdc_windows_restart.node"));
  installWindowsRestartPolicy({
    host: policy,
    app,
    log: (level, message) => {
      const dir = join(userRoot, "log");
      mkdirSync(dir, { recursive: true });
      require("node:fs").appendFileSync(join(dir, "launch.log"), `[${new Date().toISOString()}] [${level}] ${message}\n`);
    },
  });
  ipcMain.handle("codexdc:desktop-elevated", () => policy.isProcessElevated());
  // This records the loaded runtime, not just the patch currently on disk.
  const runtimeHash = desktopFingerprint(runtime, readFileSync(join(app.getAppPath(), "codexdc-loader.cjs")));
  const instances = join(userRoot, "desktop-instances");
  mkdirSync(instances, { recursive: true });
  const record = join(instances, `${process.pid}.json`);
  writeFileSync(record, JSON.stringify({
    pid: process.pid, executable: process.execPath, appRoot: dirname(process.execPath),
    reportedAt: new Date().toISOString(), runtimeHash,
  }));
  app.on("quit", () => rmSync(record, { force: true }));
}
