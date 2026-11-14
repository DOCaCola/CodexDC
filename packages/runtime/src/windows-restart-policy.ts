interface RestartHost {
  unregisterRestart(): void;
  getRestartRegistration(): { arguments: string; flags: number } | null;
}

interface SessionWindow {
  on(event: string, listener: () => void): unknown;
}

export interface RestartPolicyOptions {
  host: RestartHost;
  app: {
    whenReady(): Promise<unknown>;
    on(event: string, listener: (...args: any[]) => void): unknown;
  };
  log(level: "info" | "error", message: string): void;
}

/** Unregister in the desktop process, including late updater registrations. */
export function installWindowsRestartPolicy({ host, app, log }: RestartPolicyOptions): void {
  let lastError: string | null = null;
  const clear = () => {
    try {
      host.unregisterRestart();
      if (host.getRestartRegistration() !== null) throw new Error("Windows still reports a restart registration.");
      if (lastError) log("info", "Windows automatic restart opt-out recovered");
      lastError = null;
    } catch (error) {
      const message = `Windows automatic restart opt-out failed: ${String(error)}`;
      if (message !== lastError) log("error", message);
      lastError = message;
    }
  };
  // The first call must succeed; the loader presents a startup error otherwise.
  host.unregisterRestart();
  if (host.getRestartRegistration() !== null) throw new Error("Could not disable Windows automatic application restart.");
  log("info", "Windows automatic application restart disabled");
  // Chromium and the native updater can register after our early bootstrap.
  void app.whenReady().then(() => setImmediate(clear));
  const timer = setInterval(clear, 1_000);
  timer.unref();
  app.on("browser-window-created", (_event: unknown, window: SessionWindow) => {
    window.on("query-session-end", clear);
    window.on("session-end", clear);
  });
  app.on("before-quit", clear);
  app.on("will-quit", clear);
  app.on("quit", () => clearInterval(timer));
}
