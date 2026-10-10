import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";

/** Preserve the caller's Windows token for both launch and update relaunch. */
export function launchWindowsDesktop(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  spawnDesktop: typeof spawn = spawn,
): ChildProcess {
  // Chromium otherwise relaunches unelevated. This does not elevate a normal launch.
  const launchArgs = args.includes("--do-not-de-elevate")
    ? [...args]
    : ["--do-not-de-elevate", ...args];
  return spawnDesktop(executable, launchArgs, {
    env,
    cwd: dirname(executable),
    detached: true,
    stdio: "ignore",
  });
}
