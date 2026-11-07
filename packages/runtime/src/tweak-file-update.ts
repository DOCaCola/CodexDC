import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Serializes Store operations and keeps reloads out of directory activation. */
export class TweakFileUpdates {
  private tail: Promise<unknown> = Promise.resolve();
  private paused = false;

  get reloadsPaused(): boolean { return this.paused; }

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async activate<T>(operation: () => T, lifecycle: {
    closeWatcher(): Promise<void>;
    stopTweaks(): Promise<void>;
    reloadTweaks(): void;
    startWatcher(): void;
  }): Promise<T> {
    this.paused = true;
    try {
      await lifecycle.closeWatcher();
      await lifecycle.stopTweaks();
      return operation();
    } finally {
      try { lifecycle.reloadTweaks(); }
      finally {
        this.paused = false;
        lifecycle.startWatcher();
      }
    }
  }
}

/** Publish a fully staged tweak, retaining its backup if rollback cannot finish. */
export function replaceStoreTweak(
  staged: string,
  target: string,
  tweaksDir: string,
  files = { cpSync, existsSync, mkdtempSync, renameSync, rmSync },
): void {
  const activation = files.mkdtempSync(join(tweaksDir, ".install-"));
  const next = join(activation, "next");
  const previous = join(activation, "previous");
  let retainBackup = false;
  try {
    files.cpSync(staged, next, { recursive: true });
    if (files.existsSync(target)) files.renameSync(target, previous);
    try {
      files.renameSync(next, target);
    } catch (error) {
      if (files.existsSync(previous)) {
        try { files.renameSync(previous, target); }
        catch (rollbackError) {
          retainBackup = true;
          throw new AggregateError(
            [error, rollbackError],
            `Tweak activation and restoration failed. The original tweak is preserved at ${previous}. Close CodexDC before restoring it to ${target}.`,
          );
        }
      }
      throw error;
    }
  } catch (error) {
    if (retainBackup) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      throw new Error(
        `Could not replace ${target}: Windows or another process denied access. The existing tweak was preserved. Close programs using this directory and retry. ${String(error)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!retainBackup) files.rmSync(activation, { recursive: true, force: true });
  }
}
