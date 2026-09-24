import { detectPlatform, locateCodex, type CodexInstall, type Platform } from "./platform.js";

interface ResolveManagedCodexOptions {
  override?: string;
  recordedAppRoot?: string;
  platform?: Platform;
  locate?: (override?: string) => CodexInstall;
}

export function resolveManagedCodexInstall(opts: ResolveManagedCodexOptions = {}): CodexInstall {
  const locate = opts.locate ?? locateCodex;
  const platform = opts.platform ?? detectPlatform();

  if (opts.override) {
    return locate(opts.override);
  }

  if (platform === "win32") {
    try {
      return locate();
    } catch (error) {
      if (opts.recordedAppRoot) {
        return locate(opts.recordedAppRoot);
      }
      throw error;
    }
  }

  if (opts.recordedAppRoot) {
    return locate(opts.recordedAppRoot);
  }

  return locate();
}
