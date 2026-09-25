import { execFileSync } from "node:child_process";

/** Launch Services assigns responsibility to the new desktop, rather than the
 * exited maintenance parent. Direct spawning retains that stale responsibility
 * and can prevent local-network access even when the app has permission.
 */
export function launchMacDesktop(
  appRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  open: typeof execFileSync = execFileSync,
): void {
  // open inherits the environment; keep backend paths and secrets out of argv.
  open("/usr/bin/open", ["-a", appRoot, "--args", ...args], {
    env: { ...env, CODEXDC_DESKTOP_READY: "1" },
    stdio: "inherit",
  });
}
