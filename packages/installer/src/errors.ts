/** An expected precondition: the managed copy cannot be replaced while open. */
export class AppRunningError extends Error {
  constructor() {
    super("Close CodexDC before refreshing its managed copy.");
    this.name = "AppRunningError";
  }
}
