import { execFileSync } from "node:child_process";
import kleur from "kleur";

const developmentServices = {
  build: (root: string) => {
    for (const args of [["ci", "--ignore-scripts"], ["run", "build"]]) {
      if (process.platform === "win32") {
        // npm is a command script on Windows; the command and arguments are fixed.
        execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`],
          { cwd: root, stdio: "inherit", timeout: 10 * 60_000, windowsHide: true });
      } else {
        execFileSync("npm", args, { cwd: root, stdio: "inherit", timeout: 10 * 60_000 });
      }
    }
  },
  log: (message: string) => console.log(message),
  warn: (message: string) => console.warn(kleur.yellow(message)),
};

/** Update only a checkout without local edits or unpublished commits. */
export function updateDevelopmentCheckout(root: string, quiet = false, pull = true, services = developmentServices): boolean {
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 60_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git("status", "--porcelain", "--untracked-files=normal")) {
    services.warn("Development checkout has local changes; skipping Git pull and continuing startup with the local source.");
    return false;
  }
  if (Number(git("rev-list", "--count", "@{upstream}..HEAD")) > 0) {
    services.warn("Development checkout has local commits; skipping Git pull and continuing startup with the local source.");
    return false;
  }
  if (!pull) {
    if (!quiet) services.log("CodexDC auto-update is off.");
    return false;
  }
  const previous = git("rev-parse", "HEAD");
  if (!quiet) services.log("Development checkout: pulling from upstream...");
  git("pull", "--ff-only");
  if (git("rev-parse", "HEAD") === previous) {
    if (!quiet) services.log("Development checkout is up to date.");
    return false;
  }
  if (!quiet) services.log("Development checkout updated; installing dependencies and rebuilding...");
  services.build(root);
  return true;
}
