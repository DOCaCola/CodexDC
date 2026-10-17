import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type InstalledTweakSource =
  | { kind: "store" }
  | { kind: "development"; checkout: string }
  | { kind: "manual" };

export const STORE_INSTALL_METADATA_FILE = ".codexpp-store.json";

/**
 * Store installs carry install metadata. A tweak that resolves into a Git
 * checkout is a development install; Git owns its updates. Anything else was
 * copied into the tweaks folder by hand.
 */
export function installedTweakSource(tweakDir: string): InstalledTweakSource {
  if (existsSync(join(tweakDir, STORE_INSTALL_METADATA_FILE))) return { kind: "store" };
  const checkout = findGitCheckout(realpathSync(tweakDir));
  return checkout ? { kind: "development", checkout } : { kind: "manual" };
}

function findGitCheckout(start: string): string | null {
  let current = start;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface DevelopmentPullResult {
  before: string;
  after: string;
  upstream: string;
}

/**
 * Rebase a development checkout onto its upstream branch. Local commits are
 * preserved on top of upstream; a failed rebase is aborted so the
 * checkout is left exactly as it was.
 */
export async function pullDevelopmentCheckout(checkout: string): Promise<DevelopmentPullResult> {
  if ((await git(checkout, ["status", "--porcelain"])).trim()) {
    throw new Error(`${checkout} has uncommitted changes. Commit or stash them, then pull again.`);
  }
  const upstream = (await git(checkout, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    .catch(() => {
      throw new Error(`The current branch in ${checkout} has no upstream branch to pull from.`);
    })).trim();
  const before = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  try {
    await git(checkout, ["pull", "--rebase", "--no-autostash"]);
  } catch (error) {
    if (await rebaseInProgress(checkout)) {
      await git(checkout, ["rebase", "--abort"]);
      throw new Error(
        `Could not rebase ${checkout} onto ${upstream}. The pull was undone. ${(error as Error).message}`,
        { cause: error },
      );
    }
    throw error;
  }
  const after = (await git(checkout, ["rev-parse", "HEAD"])).trim();
  return { before, after, upstream };
}

async function rebaseInProgress(checkout: string): Promise<boolean> {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const path = (await git(checkout, ["rev-parse", "--git-path", state])).trim();
    if (existsSync(resolve(checkout, path))) return true;
  }
  return false;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}
