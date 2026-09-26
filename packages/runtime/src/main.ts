/**
 * Main-process bootstrap. Loaded by the asar loader before Codex's own
 * main process code runs. We hook `BrowserWindow` so every window Codex
 * creates gets our preload script attached. We also stand up an IPC
 * channel for tweaks to talk to the main process.
 *
 * We are in CJS land here (matches the host's main process and Codex's own
 * code). The renderer-side runtime is bundled separately into preload.js.
 */
import { app, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, shell, webContents } from "electron";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import chokidar from "chokidar";
import { selectTweakSource } from "./store-source";
import * as tar from "tar";
import { discoverTweaks, type DiscoveredTweak } from "./tweak-discovery";
import { createDiskStorage, type DiskStorage } from "./storage";
import { syncManagedMcpServers } from "./mcp-sync";
import {
  isMainProcessTweakScope,
  reloadTweaks,
  setTweakEnabledAndReload,
} from "./tweak-lifecycle";
import { appendCappedLog } from "./logging";
import {
  getCdpStatus,
  getRuntimeCapabilities,
  getRuntimeInfo,
  listCdpTargets,
} from "./codex-runtime-probe";
import { applyWindowsShellBootstrap } from "./windows-shell-bootstrap";
import { inferWindowsAppUserModelId } from "./windows-app-identity";
import { windowsTaskbarIconPath, windowsTaskbarHelperArgs } from "./windows-taskbar-icon";
import { reconcileDesktopThreadPermissions } from "./desktop-permission-state";
import { NativeBridge, type NativeTweakContext } from "./native-bridge";
import type { TweakManifest } from "@codexdc/sdk";
import type {
  CodexRuntimeCapabilities,
  CodexRuntimeInfo,
  CodexViewCreateOptions,
  CodexViewRef,
  CodexWindowRef,
  NativeHelperLaunchOptions,
  NativeModuleLoadOptions,
  NativePanelCreateOptions,
  NativeViewAttachOptions,
  TweakPermission,
} from "@codexdc/sdk";
import {
  DEFAULT_TWEAK_STORE_INDEX_URL,
  normalizeGitHubRepo,
  normalizeStoreRegistry,
  shuffleStoreEntries,
  storeArchiveUrl,
  type TweakStorePublishSubmission,
  type TweakStoreEntry,
  type TweakStoreRegistry,
  type TweakStorePlatform,
} from "./tweak-store";
import { maybeStartBrowserUiServer } from "./browser-ui";
import { installWindowsFileRevealOverride } from "./windows-file-reveal";

const userRoot = process.env.CODEXDC_USER_ROOT;
const runtimeDir = process.env.CODEXDC_RUNTIME;

if (!userRoot || !runtimeDir) {
  throw new Error(
    "codexdc runtime started without CODEXDC_USER_ROOT/RUNTIME envs",
  );
}

const PRELOAD_PATH = resolve(runtimeDir, "preload.js");
const TWEAKS_DIR = join(userRoot, "tweaks");
const LOG_DIR = join(userRoot, "log");
const LOG_FILE = join(LOG_DIR, "main.log");
const CONFIG_FILE = join(userRoot, "config.json");
const CODEX_CONFIG_FILE = join(homedir(), ".codex", "config.toml");
const CODEX_GLOBAL_STATE_FILE = join(homedir(), ".codex", ".codex-global-state.json");
const INSTALLER_STATE_FILE = join(userRoot, "state.json");
const SELF_UPDATE_STATE_FILE = join(userRoot, "self-update-state.json");
const CODEXDC_VERSION = "1.0.4";
const CODEXDC_REPO = "DOCaCola/CodexDC";
const TWEAK_STORE_INDEX_URL = process.env.CODEXDC_STORE_INDEX_URL ?? DEFAULT_TWEAK_STORE_INDEX_URL;
const CODEX_WINDOW_SERVICES_KEY = "__codexpp_window_services__";
const WINDOWS_INFERRED_APP_USER_MODEL_ID =
  process.platform === "win32" ? inferWindowsAppUserModelId(process.resourcesPath) : null;
const WINDOWS_APP_USER_MODEL_ID =
  process.platform === "win32"
    ? WINDOWS_INFERRED_APP_USER_MODEL_ID ??
      cleanOptionalString(process.env.CODEXDC_APP_USER_MODEL_ID)
    : null;
const maintenanceState = readInstallerState();
const WINDOWS_RELAUNCH_COMMAND = process.platform === "win32" && maintenanceState?.nodePath && maintenanceState.sourceRoot
  ? `"${maintenanceState.nodePath}" "${join(maintenanceState.sourceRoot, "packages", "installer", "dist", "cli.js")}" launch`
  : null;

if (process.platform === "darwin" && readInstallerState()?.managedCopy) {
  const profile = join(userRoot!, "desktop-profile");
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(TWEAKS_DIR, { recursive: true });
if (process.platform === "win32") {
  reconcileDesktopThreadPermissions({
    codexConfigPath: CODEX_CONFIG_FILE,
    statePaths: [CODEX_GLOBAL_STATE_FILE, `${CODEX_GLOBAL_STATE_FILE}.bak`],
    log,
  });
}
let taskbarRefreshTimer: ReturnType<typeof setTimeout> | null = null;
configureWindowsAppUserModelId();
if (process.platform === "win32") {
  nativeTheme.on("updated", refreshWindowsTaskbarIcons);
  void app.whenReady().then(refreshWindowsTaskbarIcons);
}
app.on("browser-window-created", (_event, win) => {
  applyWindowsWindowIcon(win);
  win.once("ready-to-show", () => applyWindowsWindowIcon(win));
  if (process.platform === "win32") win.once("show", refreshWindowsTaskbarIcons);
});
applyWindowsShellBootstrap(log, { codexConfigPath: CODEX_CONFIG_FILE });

// Optional: enable Chrome DevTools Protocol on a TCP port so we can drive the
// running Codex from outside (curl http://localhost:<port>/json, attach via
// CDP WebSocket, take screenshots, evaluate in renderer, etc.). Codex's
// production build sets webPreferences.devTools=false, which kills the
// in-window DevTools shortcut, but `--remote-debugging-port` works regardless
// because it's a Chromium command-line switch processed before app init.
//
// Off by default. Set CODEXPP_REMOTE_DEBUG=1 (optionally CODEXPP_REMOTE_DEBUG_PORT)
// to turn it on. Must be appended before `app` becomes ready; we're at module
// top-level so that's fine.
if (process.env.CODEXPP_REMOTE_DEBUG === "1") {
  const port = process.env.CODEXPP_REMOTE_DEBUG_PORT ?? "9222";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  log("info", `remote debugging enabled on port ${port}`);
}

interface PersistedState {
  codexPlusPlus?: {
    directoryOpus?: boolean;
    autoUpdate?: boolean;
    safeMode?: boolean;
    updateChannel?: SelfUpdateChannel;
    updateRepo?: string;
    updateRef?: string;
    updateCheck?: CodexPlusPlusUpdateCheck;
  };
  /** Per-tweak enable flags. Missing entries default to enabled. */
  tweaks?: Record<string, { enabled?: boolean }>;
  /** Cached GitHub release checks. Runtime never auto-installs updates. */
  tweakUpdateChecks?: Record<string, TweakUpdateCheck>;
}

interface CodexPlusPlusUpdateCheck {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  updateAvailable: boolean;
  error?: string;
}

type SelfUpdateChannel = "stable" | "prerelease" | "custom";
type SelfUpdateStatus = "checking" | "up-to-date" | "updated" | "failed" | "disabled";

interface SelfUpdateState {
  checkedAt: string;
  completedAt?: string;
  status: SelfUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  targetRef: string | null;
  releaseUrl: string | null;
  repo: string;
  channel: SelfUpdateChannel;
  sourceRoot: string;
  installationSource?: InstallationSource;
  error?: string;
}

interface InstallationSource {
  kind: "github-source" | "homebrew" | "local-dev" | "source-archive" | "unknown";
  label: string;
  detail: string;
}

interface TweakUpdateCheck {
  checkedAt: string;
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  error?: string;
}

function readState(): PersistedState {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PersistedState;
  } catch {
    return {};
  }
}
function writeState(s: PersistedState): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log("warn", "writeState failed:", String((e as Error).message));
  }
}
function isCodexPlusPlusAutoUpdateEnabled(): boolean {
  return readState().codexPlusPlus?.autoUpdate !== false;
}
function setCodexPlusPlusAutoUpdate(enabled: boolean): void {
  const s = readState();
  s.codexPlusPlus ??= {};
  s.codexPlusPlus.autoUpdate = enabled;
  writeState(s);
}
function setCodexPlusPlusUpdateConfig(config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}): void {
  const s = readState();
  s.codexPlusPlus ??= {};
  if (config.updateChannel) s.codexPlusPlus.updateChannel = config.updateChannel;
  if ("updateRepo" in config) s.codexPlusPlus.updateRepo = cleanOptionalString(config.updateRepo);
  if ("updateRef" in config) s.codexPlusPlus.updateRef = cleanOptionalString(config.updateRef);
  writeState(s);
}
function isCodexPlusPlusSafeModeEnabled(): boolean {
  return readState().codexPlusPlus?.safeMode === true;
}
function isTweakEnabled(id: string): boolean {
  const s = readState();
  if (s.codexPlusPlus?.safeMode === true) return false;
  return s.tweaks?.[id]?.enabled !== false;
}
function setTweakEnabled(id: string, enabled: boolean): void {
  const s = readState();
  s.tweaks ??= {};
  s.tweaks[id] = { ...s.tweaks[id], enabled };
  writeState(s);
}

interface InstallerState {
  managedCopy?: boolean;
  officialAppRoot?: string;
  nodePath?: string;
  sourceRoot?: string;
  appRoot: string;
  codexVersion: string | null;
}

function readInstallerState(): InstallerState | null {
  try {
    return JSON.parse(readFileSync(INSTALLER_STATE_FILE, "utf8")) as InstallerState;
  } catch {
    return null;
  }
}

function readSelfUpdateState(): SelfUpdateState | null {
  try {
    return JSON.parse(readFileSync(SELF_UPDATE_STATE_FILE, "utf8")) as SelfUpdateState;
  } catch {
    return null;
  }
}
function writeSelfUpdateState(state: SelfUpdateState): void {
  try {
    writeFileSync(SELF_UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("warn", "writeSelfUpdateState failed:", String((e as Error).message));
  }
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function configureWindowsAppUserModelId(): void {
  if (process.platform !== "win32") return;

  const appUserModelId = WINDOWS_APP_USER_MODEL_ID;
  if (!appUserModelId) {
    log("warn", "Windows AppUserModelId unavailable; taskbar identity may be process-path based");
    return;
  }

  try {
    app.setAppUserModelId(appUserModelId);
    log("info", `Windows AppUserModelId set to ${appUserModelId}`);
  } catch (error) {
    log("warn", "Failed to set Windows AppUserModelId:", String((error as Error).message));
  }
}

function applyWindowsWindowIcon(win: Electron.BrowserWindow): void {
  if (process.platform !== "win32" || win.isDestroyed()) return;
  const iconPath = windowsTaskbarIconPath(process.resourcesPath, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
  if (!existsSync(iconPath)) {
    log("warn", "Stock taskbar icons are missing; run Codex-DC Setup → Repair.");
    return;
  }

  try {
    win.setIcon(iconPath);
    log("info", "Windows taskbar icon configured", {
      windowId: win.id,
      appUserModelId: WINDOWS_APP_USER_MODEL_ID,
      iconPath,
    });
  } catch (error) {
    log("warn", "Failed to set Windows window icon:", String((error as Error).message));
  }
}

function refreshWindowsTaskbarIcons(): void {
  if (!app.isReady()) return;
  for (const win of BrowserWindow.getAllWindows()) applyWindowsWindowIcon(win);
  const iconPath = windowsTaskbarIconPath(process.resourcesPath, nativeTheme.shouldUseDarkColorsForSystemIntegratedUI);
  if (!WINDOWS_APP_USER_MODEL_ID || !WINDOWS_RELAUNCH_COMMAND || !existsSync(iconPath)) return;
  if (taskbarRefreshTimer) clearTimeout(taskbarRefreshTimer);
  taskbarRefreshTimer = setTimeout(() => {
    taskbarRefreshTimer = null;
    const windows = BrowserWindow.getAllWindows();
    if (!windows.length) return;
    execFile("powershell.exe", windowsTaskbarHelperArgs(
      join(runtimeDir!, "platform", "windows", "taskbar-icons.ps1"), iconPath,
      WINDOWS_APP_USER_MODEL_ID, process.pid, WINDOWS_RELAUNCH_COMMAND,
      windows.map(win => win.getNativeWindowHandle().readBigUInt64LE().toString()),
    ), { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) log("warn", "Windows taskbar properties update failed:", stderr || error.message);
      else log("info", "Windows taskbar properties updated:", stdout.trim());
    });
  }, 200);
}

function isPathInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}\n`;
  try {
    appendCappedLog(LOG_FILE, line);
  } catch {}
  if (level === "error") console.error("[codexdc]", ...args);
}

function installSparkleUpdateHook(): void {
  if (process.platform !== "darwin") return;

  const Module = require("node:module") as typeof import("node:module") & {
    _load?: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = Module._load;
  if (typeof originalLoad !== "function") return;

  Module._load = function codexPlusPlusModuleLoad(request: string, parent: unknown, isMain: boolean) {
    const loaded = originalLoad.apply(this, [request, parent, isMain]) as unknown;
    if (typeof request === "string" && /sparkle(?:\.node)?$/i.test(request)) {
      wrapSparkleExports(loaded);
    }
    return loaded;
  };
}

function wrapSparkleExports(loaded: unknown): void {
  if (!loaded || typeof loaded !== "object") return;
  const exports = loaded as Record<string, unknown> & { __codexppSparkleWrapped?: boolean };
  if (exports.__codexppSparkleWrapped) return;
  exports.__codexppSparkleWrapped = true;

  for (const name of ["installUpdatesIfAvailable"]) {
    const fn = exports[name];
    if (typeof fn !== "function") continue;
    exports[name] = function codexPlusPlusSparkleWrapper() {
      void runMaintenance("update-codex");
    };
  }

  if (exports.default && exports.default !== exports) {
    wrapSparkleExports(exports.default);
  }
}

// Surface unhandled errors from anywhere in the main process to our log.
process.on("uncaughtException", (e: Error & { code?: string }) => {
  log("error", "uncaughtException", { code: e.code, message: e.message, stack: e.stack });
});
process.on("unhandledRejection", (e) => {
  log("error", "unhandledRejection", { value: String(e) });
});

if (process.platform === "win32") require(join(runtimeDir!, "platform/windows/index.js")).start({ log: makeLogger("windows-update") });
installSparkleUpdateHook();

interface LoadedMainTweak {
  stop?: () => void;
  storage: DiskStorage;
}

interface CodexWindowServices {
  createFreshWindow?: (route?: string) => Promise<Electron.BrowserWindow | null>;
  createFreshLocalWindow?: (route?: string) => Promise<Electron.BrowserWindow | null>;
  ensureHostWindow?: (hostId?: string) => Promise<Electron.BrowserWindow | null>;
  getPrimaryWindow?: (hostId?: string) => Electron.BrowserWindow | null;
  getContext?: (hostId: string) => { registerWindow?: (windowLike: CodexWindowLike) => void } | null;
  windowManager?: {
    createWindow?: (opts: Record<string, unknown>) => Promise<Electron.BrowserWindow | null>;
    getPrimaryWindow?: () => Electron.BrowserWindow | null;
    registerWindow?: (
      windowLike: CodexWindowLike,
      hostId: string,
      primary: boolean,
      appearance: string,
    ) => void;
    options?: {
      allowDevtools?: boolean;
      preloadPath?: string;
    };
  };
}

interface CodexWindowLike {
  id: number;
  webContents: Electron.WebContents;
  on(event: "closed", listener: () => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  isDestroyed?(): boolean;
  isFocused?(): boolean;
  focus?(): void;
  show?(): void;
  hide?(): void;
  getBounds?(): Electron.Rectangle;
  getContentBounds?(): Electron.Rectangle;
  getSize?(): [number, number];
  getContentSize?(): [number, number];
  setTitle?(title: string): void;
  getTitle?(): string;
  setRepresentedFilename?(filename: string): void;
  setDocumentEdited?(edited: boolean): void;
  setWindowButtonVisibility?(visible: boolean): void;
}

interface CodexCreateWindowOptions {
  route: string;
  hostId?: string;
  show?: boolean;
  appearance?: string;
  parentWindowId?: number;
  bounds?: Electron.Rectangle;
}

interface CodexCreateViewOptions {
  route: string;
  hostId?: string;
  appearance?: string;
}

type OwlViewAttachMode = "contentView" | "browserView";

interface ManagedOwlView {
  key: string;
  tweakId: string;
  id: string;
  view: Electron.BrowserView;
  parentWindowId: number | null;
  attachMode: OwlViewAttachMode | null;
  disposeBindings: Array<() => void>;
  disposed: boolean;
}

const tweakState = {
  discovered: [] as DiscoveredTweak[],
  loadedMain: new Map<string, LoadedMainTweak>(),
};

const nativeBridge = new NativeBridge(log, {
  nativeHostPath: join(runtimeDir, "native", "codexpp_native_host.node"),
});
const owlViews = new Map<string, ManagedOwlView>();

const windowsFileRevealOverride = readState().codexPlusPlus?.directoryOpus === true ? installWindowsFileRevealOverride({
  shell,
  spawn: (executable, args, options) => spawn(executable, args, options),
  logWarning: (message, error) => log("warn", message, error),
}) : { installed: false, directoryOpusRuntime: null };
if (windowsFileRevealOverride.installed) {
  log(
    "info",
    `Directory Opus file reveal enabled: ${windowsFileRevealOverride.directoryOpusRuntime}`,
  );
}

const tweakLifecycleDeps = {
  logInfo: (message: string) => log("info", message),
  setTweakEnabled,
  stopAllMainTweaks,
  clearTweakModuleCache,
  loadAllMainTweaks,
  broadcastReload,
};

// 1. Hook every session so our preload runs in every renderer.
//
// Owl exposes registerPreloadScript through its host API.
function registerPreload(s: Electron.Session, label: string): void {
  try {
    s.registerPreloadScript({ type: "frame", filePath: PRELOAD_PATH, id: "codexdc" });
    log("info", `preload registered on ${label}:`, PRELOAD_PATH);
  } catch (e) {
    if (e instanceof Error && e.message.includes("existing ID")) {
      log("info", `preload already registered on ${label}:`, PRELOAD_PATH);
      return;
    }
    log("error", `preload registration on ${label} failed:`, e);
  }
}

app.whenReady().then(() => {
  log("info", "app ready fired");
  if (isCodexPlusPlusSafeModeEnabled()) {
    log("warn", "safe mode is enabled; preload will not be registered");
    return;
  }
  registerPreload(session.defaultSession, "defaultSession");
  maybeStartBrowserUiServer({
    getWindowServices: getCodexWindowServices,
    log,
  });
});

app.on("session-created", (s) => {
  if (isCodexPlusPlusSafeModeEnabled()) return;
  registerPreload(s, "session-created");
});

// DIAGNOSTIC: log every webContents creation. Useful for verifying our
// preload reaches every renderer Codex spawns.
app.on("web-contents-created", (_e, wc) => {
  try {
    const wp = (wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> })
      .getLastWebPreferences?.();
    log("info", "web-contents-created", {
      id: wc.id,
      type: wc.getType(),
      sessionIsDefault: wc.session === session.defaultSession,
      sandbox: wp?.sandbox,
      contextIsolation: wp?.contextIsolation,
    });
    wc.on("preload-error", (_ev, p, err) => {
      log("error", `wc ${wc.id} preload-error path=${p}`, String(err?.stack ?? err));
    });
  } catch (e) {
    log("error", "web-contents-created handler failed:", String((e as Error)?.stack ?? e));
  }
});

log("info", "main.ts evaluated; app.isReady=" + app.isReady());
if (isCodexPlusPlusSafeModeEnabled()) {
  log("warn", "safe mode is enabled; tweaks will not be loaded");
}

// 2. Initial tweak discovery + main-scope load.
loadAllMainTweaks();

app.on("will-quit", () => {
  stopAllMainTweaks();
  nativeBridge.disposeAll();
  disposeAllOwlViews();
  // Best-effort flush of any pending storage writes.
  for (const t of tweakState.loadedMain.values()) {
    try {
      t.storage.flush();
    } catch {}
  }
});

// 3. IPC: expose tweak metadata + reveal-in-finder.
async function runMaintenance(command: string, args: string[] = []): Promise<string> {
  const state = readInstallerState();
  if (!state?.nodePath || !state.sourceRoot) throw new Error("Codex-DC maintenance location is missing. Run Setup again.");
  const cli = join(state.sourceRoot, "packages", "installer", "dist", "cli.js");
  return new Promise((resolve, reject) => execFile(state.nodePath!, [cli, command, ...args], {
    env: { ...process.env, CODEXDC_HOME: userRoot! }, windowsHide: true,
    timeout: 15 * 60_000, maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
}

ipcMain.handle("codexdc:backend", async (_event, action: string, provider?: string) => {
  if (action === "browse") {
    const result = await dialog.showOpenDialog({
      title: "Choose local Codex CLI", properties: ["openFile"],
      ...(process.platform === "win32" ? { filters: [{ name: "Executable", extensions: ["exe"] }] } : {}),
    });
    return result.canceled ? null : result.filePaths[0];
  }
  if (!["status", "check", "install", "select", "develop", "rollback", "auto-update"].includes(action)) throw new Error("Unknown backend action");
  if (action === "auto-update" && !["on", "off"].includes(provider ?? "")) throw new Error("Unknown CLI update setting");
  if (action === "select" && !["bundled", "fork", "development"].includes(provider ?? "")) throw new Error("Unknown CLI provider");
  const result = JSON.parse(await runMaintenance("backend", [action, ...(provider ? [provider] : [])]));
  return action === "status" ? { ...result, activeExecutable: process.env.CODEX_CLI_PATH ?? null } : result;
});

ipcMain.handle("codexpp:list-tweaks", async () => {
  await Promise.all(tweakState.discovered.map((t) => ensureTweakUpdateCheck(t)));
  const updateChecks = readState().tweakUpdateChecks ?? {};
  return tweakState.discovered.map((t) => ({
    manifest: t.manifest,
    entry: t.entry,
    dir: t.dir,
    entryExists: existsSync(t.entry),
    enabled: isTweakEnabled(t.manifest.id),
    update: updateChecks[t.manifest.id] ?? null,
  }));
});

ipcMain.handle("codexpp:get-tweak-enabled", (_e, id: string) => isTweakEnabled(id));
ipcMain.handle("codexpp:set-tweak-enabled", (_e, id: string, enabled: boolean) => {
  return setTweakEnabledAndReload(id, enabled, tweakLifecycleDeps);
});

ipcMain.handle("codexpp:get-config", () => {
  const s = readState();
  const installerState = readInstallerState();
  const sourceRoot = installerState?.sourceRoot ?? null;
  return {
    version: CODEXDC_VERSION,
    autoUpdate: s.codexPlusPlus?.autoUpdate !== false,
    safeMode: s.codexPlusPlus?.safeMode === true,
    updateChannel: s.codexPlusPlus?.updateChannel ?? "stable",
    updateRepo: s.codexPlusPlus?.updateRepo ?? CODEXDC_REPO,
    updateRef: s.codexPlusPlus?.updateRef ?? "",
    updateCheck: s.codexPlusPlus?.updateCheck ?? null,
    selfUpdate: readSelfUpdateState(),
    installationSource: describeInstallationSource(sourceRoot),
  };
});

ipcMain.handle("codexpp:set-auto-update", (_e, enabled: boolean) => {
  setCodexPlusPlusAutoUpdate(!!enabled);
  return { autoUpdate: isCodexPlusPlusAutoUpdateEnabled() };
});

ipcMain.handle("codexpp:set-update-config", (_e, config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}) => {
  setCodexPlusPlusUpdateConfig(config);
  const s = readState();
  return {
    updateChannel: s.codexPlusPlus?.updateChannel ?? "stable",
    updateRepo: s.codexPlusPlus?.updateRepo ?? CODEXDC_REPO,
    updateRef: s.codexPlusPlus?.updateRef ?? "",
  };
});

ipcMain.handle("codexpp:check-codexpp-update", async (_e, force?: boolean) => {
  return ensureCodexPlusPlusUpdateCheck(force === true);
});

ipcMain.handle("codexpp:run-codexpp-update", async () => {
  throw new Error("Close Codex-DC after finishing active tasks, then run Setup → Update Codex-DC.");
});


ipcMain.handle("codexpp:get-tweak-store", async () => {
  const store = await fetchTweakStoreRegistry();
  const registry = store.registry;
  const installed = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const entries = shuffleStoreEntries(registry.entries, randomInt);
  return {
    ...registry,
    sourceUrl: TWEAK_STORE_INDEX_URL,
    fetchedAt: store.fetchedAt,
    entries: entries.map((entry) => {
      const local = installed.get(entry.id);
      const platform = storeEntryPlatformCompatibility(entry);
      const runtime = storeEntryRuntimeCompatibility(entry);
      return {
        ...entry,
        platform,
        runtime,
        installed: local
          ? {
              version: local.manifest.version,
              enabled: isTweakEnabled(local.manifest.id),
            }
          : null,
      };
    }),
  };
});

ipcMain.handle("codexpp:install-store-tweak", async (_e, id: string) => {
  const { registry } = await fetchTweakStoreRegistry();
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Tweak store entry not found: ${id}`);
  assertStoreEntryPlatformCompatible(entry);
  assertStoreEntryRuntimeCompatible(entry);
  await installStoreTweak(entry);
  reloadTweaks("store-install", tweakLifecycleDeps);
  return { installed: entry.id };
});

ipcMain.handle("codexpp:prepare-tweak-store-submission", async (_e, repoInput: string) => {
  return prepareTweakStoreSubmission(repoInput);
});

// Sandboxed renderer preload can't use Node fs to read tweak source. Main
// reads it on the renderer's behalf. Path must live under tweaksDir for
// security — we refuse anything else.
ipcMain.handle("codexpp:read-tweak-source", (_e, entryPath: string) => {
  const resolved = resolve(entryPath);
  if (!isPathInside(TWEAKS_DIR, resolved)) {
    throw new Error("path outside tweaks dir");
  }
  return require("node:fs").readFileSync(resolved, "utf8");
});

/**
 * Read an arbitrary asset file from inside a tweak's directory and return it
 * as a `data:` URL. Used by the settings injector to render manifest icons
 * (the renderer is sandboxed; `file://` won't load).
 *
 * Security: caller passes `tweakDir` and `relPath`; we (1) require tweakDir
 * to live under TWEAKS_DIR, (2) resolve relPath against it and re-check the
 * result still lives under TWEAKS_DIR, (3) cap output size at 1 MiB.
 */
const ASSET_MAX_BYTES = 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
ipcMain.handle(
  "codexpp:read-tweak-asset",
  (_e, tweakDir: string, relPath: string) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = resolve(tweakDir);
    if (!isPathInside(TWEAKS_DIR, dir)) {
      throw new Error("tweakDir outside tweaks dir");
    }
    const full = resolve(dir, relPath);
    if (!isPathInside(dir, full) || full === dir) {
      throw new Error("path traversal");
    }
    const stat = fs.statSync(full);
    if (stat.size > ASSET_MAX_BYTES) {
      throw new Error(`asset too large (${stat.size} > ${ASSET_MAX_BYTES})`);
    }
    const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const buf = fs.readFileSync(full);
    return `data:${mime};base64,${buf.toString("base64")}`;
  },
);

// Sandboxed preload can't write logs to disk; forward to us via IPC.
ipcMain.on("codexpp:preload-log", (_e, level: "info" | "warn" | "error", msg: string) => {
  const lvl = level === "error" || level === "warn" ? level : "info";
  try {
    appendCappedLog(join(LOG_DIR, "preload.log"), `[${new Date().toISOString()}] [${lvl}] ${msg}\n`);
  } catch {}
});

// Sandbox-safe filesystem ops for renderer-scope tweaks. Each tweak gets
// a sandboxed dir under userRoot/tweak-data/<id>. Renderer side calls these
// over IPC instead of using Node fs directly.
ipcMain.handle("codexpp:tweak-fs", (_e, op: string, id: string, p: string, c?: string) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("bad tweak id");
  const dir = join(userRoot!, "tweak-data", id);
  mkdirSync(dir, { recursive: true });
  const full = resolve(dir, p);
  if (!isPathInside(dir, full) || full === dir) throw new Error("path traversal");
  const fs = require("node:fs") as typeof import("node:fs");
  switch (op) {
    case "read": return fs.readFileSync(full, "utf8");
    case "write": return fs.writeFileSync(full, c ?? "", "utf8");
    case "exists": return fs.existsSync(full);
    case "dataDir": return dir;
    default: throw new Error(`unknown op: ${op}`);
  }
});

ipcMain.handle("codexpp:user-paths", () => ({
  userRoot,
  runtimeDir,
  tweaksDir: TWEAKS_DIR,
  logDir: LOG_DIR,
}));

ipcMain.handle("codexpp:codex-runtime-info", () => currentRuntimeInfo());
ipcMain.handle("codexpp:codex-runtime-capabilities", () => currentRuntimeCapabilities());
ipcMain.handle("codexpp:codex-cdp-status", () => getCdpStatus());
ipcMain.handle("codexpp:codex-cdp-targets", () => listCdpTargets());
ipcMain.handle("codexpp:codex-file-stat", (_e, tweakId: string, path: string) => {
  assertTweakPermissionForId(tweakId, "filesystem");
  return statExternalFile(path);
});
ipcMain.handle("codexpp:codex-file-show-in-folder", (_e, tweakId: string, path: string) => {
  assertTweakPermissionForId(tweakId, "filesystem");
  return showExternalFileInFolder(path);
});
ipcMain.handle("codexpp:codex-window-create", (_e, opts: CodexCreateWindowOptions) => {
  return createCodexWindow(opts);
});
ipcMain.handle("codexpp:codex-window-primary", () => getPrimaryCodexWindowRef());
ipcMain.handle("codexpp:codex-window-focus", (_e, windowId: number) => focusCodexWindow(windowId));
ipcMain.handle("codexpp:codex-window-show", (_e, windowId: number) => showCodexWindow(windowId));
ipcMain.handle(
  "codexpp:codex-view-create",
  async (_e, tweakId: string, options: CodexViewCreateOptions) => {
    const tweak = assertTweakViewPermissionForId(tweakId);
    const ref = await createOwlView({ id: tweak.manifest.id, dir: tweak.dir }, options);
    return {
      id: ref.id,
      webContentsId: ref.webContentsId,
      parentWindowId: ref.parentWindowId,
    };
  },
);
ipcMain.handle(
  "codexpp:codex-view-call",
  (_e, tweakId: string, viewId: string, method: string, arg?: unknown, arg2?: unknown) => {
    assertTweakViewPermissionForId(tweakId);
    return callOwlView(tweakId, viewId, method, arg, arg2);
  },
);
ipcMain.handle("codexpp:codex-view-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  disposeOwlViewsForTweak(tweakId);
});
ipcMain.handle(
  "codexpp:native-load-module",
  (_e, tweakId: string, options: NativeModuleLoadOptions) => {
    const ref = nativeBridge.loadModule(tweakContext(tweakId, "native-module"), options);
    return { id: ref.id, kind: ref.kind };
  },
);
ipcMain.handle(
  "codexpp:native-module-request",
  (_e, tweakId: string, moduleId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-module");
    return nativeBridge.requestModule(tweakId, moduleId, method, payload, timeoutMs);
  },
);
ipcMain.handle("codexpp:native-module-dispose", (_e, tweakId: string, moduleId: string) => {
  assertTweakPermissionForId(tweakId, "native-module");
  return nativeBridge.disposeModule(tweakId, moduleId);
});
ipcMain.handle("codexpp:native-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  nativeBridge.disposeTweak(tweakId);
});
ipcMain.handle(
  "codexpp:native-create-panel",
  async (_e, tweakId: string, options: NativePanelCreateOptions) => {
    const ref = await nativeBridge.createPanel(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id, windowId: ref.windowId };
  },
);
ipcMain.handle(
  "codexpp:native-attach-view",
  async (_e, tweakId: string, options: NativeViewAttachOptions) => {
    const ref = await nativeBridge.attachView(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id };
  },
);
ipcMain.handle(
  "codexpp:native-instance-call",
  async (_e, tweakId: string, kind: "panel" | "view", instanceId: string, method: string, arg?: unknown) => {
    assertTweakPermissionForId(tweakId, "native-view");
    return nativeBridge.callInstance(tweakId, kind, instanceId, method, arg);
  },
);
ipcMain.handle(
  "codexpp:native-launch-helper",
  (_e, tweakId: string, options: NativeHelperLaunchOptions) => {
    const ref = nativeBridge.launchHelper(tweakContext(tweakId, "native-helper"), options);
    return { id: ref.id, pid: ref.pid };
  },
);
ipcMain.handle(
  "codexpp:native-helper-call",
  (_e, tweakId: string, helperId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-helper");
    return nativeBridge.callHelper(tweakId, helperId, method, payload, timeoutMs);
  },
);

ipcMain.handle("codexpp:reveal", (_e, p: string) => {
  shell.openPath(p).catch(() => {});
});

ipcMain.handle("codexpp:open-external", (_e, url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("only github.com links can be opened from tweak metadata");
  }
  shell.openExternal(parsed.toString()).catch(() => {});
});

ipcMain.handle("codexpp:copy-text", (_e, text: string) => {
  clipboard.writeText(String(text));
  return true;
});

// Manual force-reload trigger from the renderer (e.g. the "Force Reload"
// button on our injected Tweaks page). Bypasses the watcher debounce.
ipcMain.handle("codexpp:reload-tweaks", () => {
  reloadTweaks("manual", tweakLifecycleDeps);
  return { at: Date.now(), count: tweakState.discovered.length };
});

// 4. Filesystem watcher → debounced reload + broadcast.
//    We watch the tweaks dir for any change. On the first tick of inactivity
//    we stop main-side tweaks, clear their cached modules, re-discover, then
//    restart and broadcast `codexpp:tweaks-changed` to every renderer so it
//    can re-init its host.
const RELOAD_DEBOUNCE_MS = 250;
let reloadTimer: NodeJS.Timeout | null = null;
function scheduleReload(reason: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadTweaks(reason, tweakLifecycleDeps);
  }, RELOAD_DEBOUNCE_MS);
}

try {
  const watcher = chokidar.watch(TWEAKS_DIR, {
    ignoreInitial: true,
    // Wait for files to settle before triggering — guards against partially
    // written tweak files during editor saves / git checkouts.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    // Avoid eating CPU on huge node_modules trees inside tweak folders.
    ignored: (p) => p.includes(`${TWEAKS_DIR}/`) && /\/node_modules\//.test(p),
  });
  watcher.on("all", (event, path) => scheduleReload(`${event} ${path}`));
  watcher.on("error", (e) => log("warn", "watcher error:", e));
  log("info", "watching", TWEAKS_DIR);
  app.on("will-quit", () => watcher.close().catch(() => {}));
} catch (e) {
  log("error", "failed to start watcher:", e);
}

// --- helpers ---

function loadAllMainTweaks(): void {
  try {
    tweakState.discovered = discoverTweaks(TWEAKS_DIR);
    log(
      "info",
      `discovered ${tweakState.discovered.length} tweak(s):`,
      tweakState.discovered.map((t) => t.manifest.id).join(", "),
    );
  } catch (e) {
    log("error", "tweak discovery failed:", e);
    tweakState.discovered = [];
  }

  syncMcpServersFromEnabledTweaks();

  for (const t of tweakState.discovered) {
    if (!isMainProcessTweakScope(t.manifest.scope)) continue;
    if (!isTweakEnabled(t.manifest.id)) {
      log("info", `skipping disabled main tweak: ${t.manifest.id}`);
      continue;
    }
    try {
      const mod = require(t.entry);
      const tweak = mod.default ?? mod;
      if (typeof tweak?.start === "function") {
        const storage = createDiskStorage(userRoot!, t.manifest.id);
        tweak.start({
          manifest: t.manifest,
          process: "main",
          log: makeLogger(t.manifest.id),
          storage,
          ipc: makeMainIpc(t.manifest.id),
          fs: makeMainFs(t.manifest.id),
          codex: makeCodexApi(t),
        });
        tweakState.loadedMain.set(t.manifest.id, {
          stop: tweak.stop,
          storage,
        });
        log("info", `started main tweak: ${t.manifest.id}`);
      }
    } catch (e) {
      log("error", `tweak ${t.manifest.id} failed to start:`, e);
    }
  }
}

function syncMcpServersFromEnabledTweaks(): void {
  try {
    const result = syncManagedMcpServers({
      configPath: CODEX_CONFIG_FILE,
      tweaks: tweakState.discovered.filter((t) => isTweakEnabled(t.manifest.id)),
    });
    if (result.changed) {
      log("info", `synced Codex MCP config: ${result.serverNames.join(", ") || "none"}`);
    }
    if (result.skippedServerNames.length > 0) {
      log(
        "info",
        `skipped Codex-DC managed MCP server(s) already configured by user: ${result.skippedServerNames.join(", ")}`,
      );
    }
  } catch (e) {
    log("warn", "failed to sync Codex MCP config:", e);
  }
}

function stopAllMainTweaks(): void {
  for (const [id, t] of tweakState.loadedMain) {
    try {
      t.stop?.();
      t.storage.flush();
      log("info", `stopped main tweak: ${id}`);
    } catch (e) {
      log("warn", `stop failed for ${id}:`, e);
    } finally {
      nativeBridge.disposeTweak(id);
      disposeOwlViewsForTweak(id);
    }
  }
  tweakState.loadedMain.clear();
}

function clearTweakModuleCache(): void {
  const rootSet = new Set<string>([TWEAKS_DIR, safeRealpath(TWEAKS_DIR)]);
  const entrySet = new Set<string>();
  for (const tweak of tweakState.discovered) {
    rootSet.add(tweak.dir);
    rootSet.add(safeRealpath(tweak.dir));
    entrySet.add(tweak.entry);
    entrySet.add(safeRealpath(tweak.entry));
  }

  const roots = [...rootSet];
  for (const key of Object.keys(require.cache)) {
    const realKey = safeRealpath(key);
    const isTweakModule =
      entrySet.has(key) ||
      entrySet.has(realKey) ||
      roots.some((root) => isPathInside(root, key) || isPathInside(root, realKey));
    if (isTweakModule) delete require.cache[key];
  }
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

async function ensureCodexPlusPlusUpdateCheck(force = false): Promise<CodexPlusPlusUpdateCheck> {
  const state = readState();
  const cached = state.codexPlusPlus?.updateCheck;
  const channel = state.codexPlusPlus?.updateChannel ?? "stable";
  const repo = state.codexPlusPlus?.updateRepo ?? CODEXDC_REPO;
  if (
    !force &&
    cached &&
    cached.currentVersion === CODEXDC_VERSION &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return cached;
  }

  const release = await fetchLatestRelease(repo, CODEXDC_VERSION, channel === "prerelease");
  const latestVersion = release.latestTag ? normalizeVersion(release.latestTag) : null;
  const check: CodexPlusPlusUpdateCheck = {
    checkedAt: new Date().toISOString(),
    currentVersion: CODEXDC_VERSION,
    latestVersion,
    releaseUrl: release.releaseUrl ?? `https://github.com/${repo}/releases`,
    releaseNotes: release.releaseNotes,
    updateAvailable: latestVersion
      ? compareVersions(normalizeVersion(latestVersion), CODEXDC_VERSION) > 0
      : false,
    ...(release.error ? { error: release.error } : {}),
  };
  state.codexPlusPlus ??= {};
  state.codexPlusPlus.updateCheck = check;
  writeState(state);
  return check;
}

async function ensureTweakUpdateCheck(t: DiscoveredTweak): Promise<void> {
  const id = t.manifest.id;
  const repo = t.manifest.githubRepo;
  if (!repo) {
    return;
  }
  const state = readState();
  const cached = state.tweakUpdateChecks?.[id];
  if (
    cached &&
    cached.repo === repo &&
    cached.currentVersion === t.manifest.version &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return;
  }

  if (repo === "DOCaCola/CodexDC-Tweaks") {
    try {
      const { registry } = await fetchTweakStoreRegistry();
      const entry = registry.entries.find((candidate) => candidate.id === id);
      state.tweakUpdateChecks ??= {};
      state.tweakUpdateChecks[id] = { checkedAt: new Date().toISOString(), repo,
        currentVersion: t.manifest.version, latestVersion: entry?.manifest.version ?? null,
        latestTag: null, releaseUrl: entry?.releaseUrl ?? null,
        updateAvailable: !!entry && compareVersions(entry.manifest.version, t.manifest.version) > 0 };
      writeState(state);
    } catch (error) { log("warn", "Catalog update check failed", String(error)); }
    return;
  }
  const next = await fetchLatestRelease(repo, t.manifest.version);
  const latestVersion = next.latestTag ? normalizeVersion(next.latestTag) : null;
  const check: TweakUpdateCheck = {
    checkedAt: new Date().toISOString(),
    repo,
    currentVersion: t.manifest.version,
    latestVersion,
    latestTag: next.latestTag,
    releaseUrl: next.releaseUrl,
    updateAvailable: latestVersion
      ? compareVersions(latestVersion, normalizeVersion(t.manifest.version)) > 0
      : false,
    ...(next.error ? { error: next.error } : {}),
  };
  state.tweakUpdateChecks ??= {};
  state.tweakUpdateChecks[id] = check;
  writeState(state);
}

async function fetchLatestRelease(
  repo: string,
  currentVersion: string,
  includePrerelease = false,
): Promise<{ latestTag: string | null; releaseUrl: string | null; releaseNotes: string | null; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const endpoint = includePrerelease ? "releases?per_page=20" : "releases/latest";
      const res = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": `codexdc/${currentVersion}`,
        },
        signal: controller.signal,
      });
      if (res.status === 404) {
        return { latestTag: null, releaseUrl: null, releaseNotes: null, error: "no GitHub release found" };
      }
      if (!res.ok) {
        return { latestTag: null, releaseUrl: null, releaseNotes: null, error: `GitHub returned ${res.status}` };
      }
      const json = await res.json() as { tag_name?: string; html_url?: string; body?: string; draft?: boolean } | Array<{ tag_name?: string; html_url?: string; body?: string; draft?: boolean }>;
      const body = Array.isArray(json) ? json.find((release) => !release.draft) : json;
      if (!body) {
        return { latestTag: null, releaseUrl: null, releaseNotes: null, error: "no GitHub release found" };
      }
      return {
        latestTag: body.tag_name ?? null,
        releaseUrl: body.html_url ?? `https://github.com/${repo}/releases`,
        releaseNotes: body.body ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return {
      latestTag: null,
      releaseUrl: null,
      releaseNotes: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

interface TweakStoreFetchResult {
  registry: TweakStoreRegistry;
  fetchedAt: string;
}

interface StoreInstallMetadata {
  repo: string;
  path?: string;
  approvedCommitSha: string;
  installedAt: string;
  storeIndexUrl: string;
  files?: Record<string, string>;
}

interface StoreEntryPlatformCompatibility {
  current: NodeJS.Platform;
  supported: TweakStorePlatform[] | null;
  compatible: boolean;
  reason: string | null;
}

interface StoreEntryRuntimeCompatibility {
  current: string;
  required: string | null;
  compatible: boolean;
  reason: string | null;
}

class StoreTweakModifiedError extends Error {
  constructor(tweakName: string) {
    super(
      `${tweakName} has local source changes, so Codex-DC can't auto-update it. Revert your local changes or reinstall the tweak manually.`,
    );
    this.name = "StoreTweakModifiedError";
  }
}

function storeEntryPlatformCompatibility(entry: TweakStoreEntry): StoreEntryPlatformCompatibility {
  const supported = entry.platforms ?? null;
  const compatible = !supported || supported.includes(process.platform as TweakStorePlatform);
  return {
    current: process.platform,
    supported,
    compatible,
    reason: compatible ? null : `${entry.manifest.name} is only available on ${formatStorePlatforms(supported)}.`,
  };
}

function assertStoreEntryPlatformCompatible(entry: TweakStoreEntry): void {
  const platform = storeEntryPlatformCompatibility(entry);
  if (!platform.compatible) {
    throw new Error(platform.reason ?? `${entry.manifest.name} is not available on this platform.`);
  }
}

function storeEntryRuntimeCompatibility(entry: TweakStoreEntry): StoreEntryRuntimeCompatibility {
  const required = cleanMinRuntime(entry.manifest.minRuntime);
  const compatible = !required || compareVersions(CODEXDC_VERSION, required) >= 0;
  return {
    current: CODEXDC_VERSION,
    required,
    compatible,
    reason: compatible || !required
      ? null
      : `${entry.manifest.name} requires Codex-DC ${required} or newer.`,
  };
}

function assertStoreEntryRuntimeCompatible(entry: TweakStoreEntry): void {
  const runtime = storeEntryRuntimeCompatibility(entry);
  if (!runtime.compatible) {
    throw new Error(runtime.reason ?? `${entry.manifest.name} requires a newer Codex-DC runtime.`);
  }
}

function cleanMinRuntime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = normalizeVersion(value.replace(/^>=?\s*/, ""));
  return VERSION_RE.test(version) ? version : null;
}

function formatStorePlatforms(platforms: TweakStorePlatform[] | null): string {
  if (!platforms || platforms.length === 0) return "supported platforms";
  return platforms.map((platform) => {
    if (platform === "darwin") return "macOS";
    if (platform === "win32") return "Windows";
    return "Linux";
  }).join(", ");
}

async function fetchTweakStoreRegistry(): Promise<TweakStoreFetchResult> {
  const fetchedAt = new Date().toISOString();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(TWEAK_STORE_INDEX_URL, {
        headers: {
          "Accept": "application/json",
          "User-Agent": `codexdc/${CODEXDC_VERSION}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`store returned ${res.status}`);
      return {
        registry: normalizeStoreRegistry(await res.json()),
        fetchedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    log("warn", "failed to fetch tweak store registry:", error.message);
    throw error;
  }
}

async function installStoreTweak(entry: TweakStoreEntry): Promise<void> {
  const url = storeArchiveUrl(entry);
  const work = mkdtempSync(join(tmpdir(), "codexpp-store-tweak-"));
  const archive = join(work, "source.tar.gz");
  const extractDir = join(work, "extract");
  const existing = tweakState.discovered.find((t) => t.manifest.id === entry.id);
  const target = existing?.dir ?? join(TWEAKS_DIR, entry.id);
  const stagedTarget = join(work, "staged", entry.id);

  try {
    log("info", `installing store tweak ${entry.id} from ${entry.repo}@${entry.approvedCommitSha}`);
    const res = await fetch(url, {
      headers: { "User-Agent": `codexdc/${CODEXDC_VERSION}` },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    writeFileSync(archive, bytes);
    mkdirSync(extractDir, { recursive: true });
    extractTarArchive(archive, extractDir);
    const source = selectTweakSource(extractDir, entry.path);
    if (!source) throw new Error("downloaded archive did not contain manifest.json");
    validateStoreTweakSource(entry, source);
    rmSync(stagedTarget, { recursive: true, force: true });
    copyTweakSource(source, stagedTarget);
    const stagedFiles = hashTweakSource(stagedTarget);
    writeFileSync(
      join(stagedTarget, ".codexpp-store.json"),
      JSON.stringify(
        {
          repo: entry.repo,
          path: entry.path,
          approvedCommitSha: entry.approvedCommitSha,
          installedAt: new Date().toISOString(),
          storeIndexUrl: TWEAK_STORE_INDEX_URL,
          files: stagedFiles,
        },
        null,
        2,
      ),
    );
    await assertStoreTweakCleanForAutoUpdate(entry, target, work);
    const activation = mkdtempSync(join(TWEAKS_DIR, ".install-"));
    const next = join(activation, "next");
    const previous = join(activation, "previous");
    try {
      cpSync(stagedTarget, next, { recursive: true });
      if (existsSync(target)) renameSync(target, previous);
      try { renameSync(next, target); } catch (error) {
        if (existsSync(previous)) renameSync(previous, target);
        throw error;
      }
    } finally { rmSync(activation, { recursive: true, force: true }); }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function prepareTweakStoreSubmission(repoInput: string): Promise<TweakStorePublishSubmission> {
  const repo = normalizeGitHubRepo(repoInput);
  const repoInfo = await fetchGithubJson<{ default_branch?: string }>(`https://api.github.com/repos/${repo}`);
  const defaultBranch = repoInfo.default_branch;
  if (!defaultBranch) throw new Error(`Could not resolve default branch for ${repo}`);

  const commit = await fetchGithubJson<{
    sha?: string;
    html_url?: string;
  }>(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(defaultBranch)}`);
  if (!commit.sha) throw new Error(`Could not resolve current commit for ${repo}`);

  const manifest = await fetchManifestAtCommit(repo, commit.sha).catch((e) => {
    log("warn", `could not read manifest for store submission ${repo}@${commit.sha}:`, e);
    return undefined;
  });

  return {
    repo,
    defaultBranch,
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? `https://github.com/${repo}/commit/${commit.sha}`,
    manifest: manifest
      ? {
          id: typeof manifest.id === "string" ? manifest.id : undefined,
          name: typeof manifest.name === "string" ? manifest.name : undefined,
          version: typeof manifest.version === "string" ? manifest.version : undefined,
          description: typeof manifest.description === "string" ? manifest.description : undefined,
          iconUrl: typeof manifest.iconUrl === "string" ? manifest.iconUrl : undefined,
        }
      : undefined,
  };
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `codexdc/${CODEXDC_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchManifestAtCommit(repo: string, commitSha: string): Promise<Partial<TweakManifest>> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commitSha}/manifest.json`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": `codexdc/${CODEXDC_VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`manifest fetch returned ${res.status}`);
  return await res.json() as Partial<TweakManifest>;
}

function extractTarArchive(archive: string, targetDir: string): void {
  tar.t({ file: archive, sync: true, onReadEntry(entry) {
    if (entry.path.includes("\\") || entry.path.startsWith("/") || entry.path.includes(":") ||
        entry.path.split("/").includes("..") || !["File", "Directory"].includes(entry.type)) {
      throw new Error("Unsafe tweak archive entry");
    }
  } });
  tar.x({ file: archive, cwd: targetDir, sync: true, strict: true, preservePaths: false });
}

function validateStoreTweakSource(entry: TweakStoreEntry, source: string): void {
  const manifestPath = join(source, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TweakManifest;
  if (manifest.id !== entry.manifest.id) {
    throw new Error(`downloaded tweak id ${manifest.id} does not match approved id ${entry.manifest.id}`);
  }
  if (manifest.githubRepo !== entry.repo) {
    throw new Error(`downloaded tweak repo ${manifest.githubRepo} does not match approved repo ${entry.repo}`);
  }
  if (manifest.version !== entry.manifest.version) {
    throw new Error(`downloaded tweak version ${manifest.version} does not match approved version ${entry.manifest.version}`);
  }
}

function copyTweakSource(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(?:\.git|node_modules)(?:[/\\]|$)/.test(src),
  });
}

async function assertStoreTweakCleanForAutoUpdate(
  entry: TweakStoreEntry,
  target: string,
  work: string,
): Promise<void> {
  if (!existsSync(target)) return;
  const metadata = readStoreInstallMetadata(target);
  if (!metadata) throw new StoreTweakModifiedError(entry.manifest.name);
  if (metadata.repo !== entry.repo || (metadata.path ?? ".") !== (entry.path ?? ".")) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
  const currentFiles = hashTweakSource(target);
  const baselineFiles = metadata.files ?? await fetchBaselineStoreTweakHashes(metadata, work);
  if (!sameFileHashes(currentFiles, baselineFiles)) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
}

function readStoreInstallMetadata(target: string): StoreInstallMetadata | null {
  const metadataPath = join(target, ".codexpp-store.json");
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<StoreInstallMetadata>;
    if (typeof parsed.repo !== "string" || typeof parsed.approvedCommitSha !== "string") return null;
    return {
      repo: parsed.repo,
      path: parsed.path,
      approvedCommitSha: parsed.approvedCommitSha,
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      storeIndexUrl: typeof parsed.storeIndexUrl === "string" ? parsed.storeIndexUrl : "",
      files: isHashRecord(parsed.files) ? parsed.files : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchBaselineStoreTweakHashes(
  metadata: StoreInstallMetadata,
  work: string,
): Promise<Record<string, string>> {
  const baselineDir = join(work, "baseline");
  const archive = join(work, "baseline.tar.gz");
  const res = await fetch(`https://codeload.github.com/${metadata.repo}/tar.gz/${metadata.approvedCommitSha}`, {
    headers: { "User-Agent": `codexdc/${CODEXDC_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Could not verify local tweak changes before update: ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  mkdirSync(baselineDir, { recursive: true });
  extractTarArchive(archive, baselineDir);
  const source = selectTweakSource(baselineDir, metadata.path);
  if (!source) throw new Error("Could not verify local tweak changes before update: baseline manifest missing");
  return hashTweakSource(source);
}

function hashTweakSource(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  collectTweakFileHashes(root, root, out);
  return out;
}

function collectTweakFileHashes(root: string, dir: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules" || name === ".codexpp-store.json") continue;
    const full = join(dir, name);
    const rel = relative(root, full).split("\\").join("/");
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTweakFileHashes(root, full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
}

function sameFileHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (key !== bk[i] || a[key] !== b[key]) return false;
  }
  return true;
}

function isHashRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const av = VERSION_RE.exec(a);
  const bv = VERSION_RE.exec(b);
  if (!av || !bv) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(av[i]) - Number(bv[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function describeInstallationSource(sourceRoot: string | null): InstallationSource {
  if (!sourceRoot) {
    return {
      kind: "unknown",
      label: "Unknown",
      detail: "Codex-DC source location is not recorded yet.",
    };
  }
  const normalized = sourceRoot.replace(/\\/g, "/");
  if (/\/(?:Homebrew|homebrew)\/Cellar\/codexdc\//.test(normalized)) {
    return { kind: "homebrew", label: "Homebrew", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, ".git"))) {
    return { kind: "local-dev", label: "Local development checkout", detail: sourceRoot };
  }
  if (normalized.endsWith("/.codexdc/source") || normalized.includes("/.codexdc/source/")) {
    return { kind: "github-source", label: "GitHub source installer", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, "package.json"))) {
    return { kind: "source-archive", label: "Source archive", detail: sourceRoot };
  }
  return { kind: "unknown", label: "Unknown", detail: sourceRoot };
}

function broadcastReload(): void {
  const payload = {
    at: Date.now(),
    tweaks: tweakState.discovered.map((t) => t.manifest.id),
  };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send("codexpp:tweaks-changed", payload);
    } catch (e) {
      log("warn", "broadcast send failed:", e);
    }
  }
}

function makeLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => log("info", `[${scope}]`, ...a),
    info: (...a: unknown[]) => log("info", `[${scope}]`, ...a),
    warn: (...a: unknown[]) => log("warn", `[${scope}]`, ...a),
    error: (...a: unknown[]) => log("error", `[${scope}]`, ...a),
  };
}

function makeMainIpc(id: string) {
  const ch = (c: string) => `codexpp:${id}:${c}`;
  return {
    on: (c: string, h: (...args: unknown[]) => void) => {
      const wrapped = (_e: unknown, ...args: unknown[]) => h(...args);
      ipcMain.on(ch(c), wrapped);
      return () => ipcMain.removeListener(ch(c), wrapped as never);
    },
    send: (_c: string) => {
      throw new Error("ipc.send is renderer→main; main side uses handle/on");
    },
    invoke: (_c: string) => {
      throw new Error("ipc.invoke is renderer→main; main side uses handle");
    },
    handle: (c: string, handler: (...args: unknown[]) => unknown) => {
      ipcMain.handle(ch(c), (_e: unknown, ...args: unknown[]) => handler(...args));
    },
  };
}

function makeMainFs(id: string) {
  const dir = join(userRoot!, "tweak-data", id);
  mkdirSync(dir, { recursive: true });
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  return {
    dataDir: dir,
    read: (p: string) => fs.readFile(join(dir, p), "utf8"),
    write: (p: string, c: string) => fs.writeFile(join(dir, p), c, "utf8"),
    exists: async (p: string) => {
      try {
        await fs.access(join(dir, p));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function currentRuntimeInfo(): CodexRuntimeInfo {
  const installerState = readInstallerState();
  return getRuntimeInfo({
    userRoot: userRoot!,
    runtimeDir: runtimeDir!,
    codexVersion: installerState?.codexVersion ?? null,
    channel: null,
    getWindowServices: getCodexWindowServices,
  });
}

function currentRuntimeCapabilities(): CodexRuntimeCapabilities {
  const installerState = readInstallerState();
  return getRuntimeCapabilities({
    userRoot: userRoot!,
    runtimeDir: runtimeDir!,
    codexVersion: installerState?.codexVersion ?? null,
    channel: null,
    getWindowServices: getCodexWindowServices,
    getNativeCapabilities: () => nativeBridge.getCapabilities(),
    getViewCapabilities: () => getOwlViewCapabilities(),
  });
}

function statExternalFile(path: string): {
  exists: boolean;
  isFile: boolean;
  mtimeMs: number | null;
  size: number | null;
} {
  const normalized = normalizeExternalFilePath(path);
  try {
    const stat = statSync(normalized);
    return {
      exists: true,
      isFile: stat.isFile(),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, isFile: false, mtimeMs: null, size: null };
    }
    throw error;
  }
}

function showExternalFileInFolder(path: string): boolean {
  const normalized = normalizeExternalFilePath(path);
  const stat = statSync(normalized);
  if (!stat.isFile()) throw new Error(`path is not a file: ${normalized}`);
  shell.showItemInFolder(normalized);
  return true;
}

function normalizeExternalFilePath(path: string): string {
  if (typeof path !== "string") throw new Error("path must be a string");
  const value = path.trim();
  if (!value) throw new Error("path must not be empty");
  if (value.length > 32_768) throw new Error("path is too long");
  if (!isAbsolute(value)) throw new Error("path must be absolute");
  return resolve(value);
}

function tweakContext(tweakId: string, permission?: TweakPermission): NativeTweakContext {
  const tweak = permission
    ? assertTweakPermissionForId(tweakId, permission)
    : tweakById(tweakId);
  return { id: tweak.manifest.id, dir: tweak.dir };
}

function tweakById(tweakId: string): DiscoveredTweak {
  assertTweakId(tweakId);
  const tweak = tweakState.discovered.find((item) => item.manifest.id === tweakId);
  if (!tweak) throw new Error(`unknown tweak: ${tweakId}`);
  if (!isTweakEnabled(tweakId)) throw new Error(`tweak is disabled: ${tweakId}`);
  return tweak;
}

function assertTweakPermissionForId(tweakId: string, permission: TweakPermission): DiscoveredTweak {
  const tweak = tweakById(tweakId);
  assertTweakPermission(tweak, permission);
  return tweak;
}

function assertTweakViewPermissionForId(tweakId: string): DiscoveredTweak {
  const tweak = tweakById(tweakId);
  assertTweakViewPermission(tweak);
  return tweak;
}

function assertTweakPermission(tweak: DiscoveredTweak, permission: TweakPermission): void {
  if (tweak.manifest.permissions?.includes(permission)) return;
  throw new Error(`tweak ${tweak.manifest.id} must declare ${permission} permission`);
}

function assertTweakViewPermission(tweak: DiscoveredTweak): void {
  if (
    tweak.manifest.permissions?.includes("codex-views") ||
    tweak.manifest.permissions?.includes("codex.views")
  ) {
    return;
  }
  throw new Error(`tweak ${tweak.manifest.id} must declare codex-views permission`);
}

function assertTweakId(tweakId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(tweakId)) throw new Error("bad tweak id");
}

function getPrimaryCodexWindow(): Electron.BrowserWindow | null {
  const services = getCodexWindowServices();
  const fromServices = typeof services?.getPrimaryWindow === "function"
    ? services.getPrimaryWindow("local")
    : null;
  if (fromServices && !fromServices.isDestroyed()) return fromServices;
  const fromManager = typeof services?.windowManager?.getPrimaryWindow === "function"
    ? services.windowManager.getPrimaryWindow.call(services.windowManager)
    : null;
  if (fromManager && !fromManager.isDestroyed()) return fromManager;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
}

function getPrimaryCodexWindowRef(): CodexWindowRef | null {
  const win = getPrimaryCodexWindow();
  if (!win || win.isDestroyed()) return null;
  return { windowId: win.id, webContentsId: win.webContents.id };
}

function focusCodexWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function showCodexWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  win.show();
  return true;
}

function getOwlViewCapabilities(): CodexRuntimeCapabilities["views"] {
  const parent = getPrimaryCodexWindow() ?? BrowserWindow.getFocusedWindow();
  const contentView = asRecord(parent)?.contentView;
  let sampleView: Electron.BrowserView | null = null;
  try {
    sampleView = new BrowserView({ webPreferences: { sandbox: true } });
  } catch {}
  const webContentsView = asRecord(sampleView)?.webContentsView;
  const privateViewTree = typeof asRecord(contentView)?.addChildView === "function" &&
    typeof asRecord(contentView)?.removeChildView === "function";
  const webContentsViewAvailable = Boolean(webContentsView) &&
    typeof asRecord(webContentsView)?.setBounds === "function";
  const privateAttach = privateViewTree && webContentsViewAvailable;
  const browserViewFallback = typeof asRecord(parent)?.addBrowserView === "function";
  try {
    if (sampleView && !sampleView.webContents.isDestroyed()) {
      sampleView.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {}
  return {
    create: privateAttach || browserViewFallback,
    privateViewTree: privateAttach,
    webContentsView: webContentsViewAvailable,
    browserViewFallback,
  };
}

async function createOwlView(
  ctx: NativeTweakContext,
  opts: CodexViewCreateOptions,
): Promise<CodexViewRef> {
  const id = assertBridgeId(opts.id ?? randomUUID(), "Codex view id");
  const key = owlViewKey(ctx.id, id);
  if (owlViews.has(key)) throw new Error(`Codex view already exists: ${ctx.id}:${id}`);

  const parent = typeof opts.parentWindowId === "number"
    ? BrowserWindow.fromId(opts.parentWindowId)
    : getPrimaryCodexWindow();
  if (!parent || isWindowDestroyed(parent)) {
    throw new Error("Codex view needs an active parent window");
  }

  const services = getCodexWindowServices();
  const windowManager = services?.windowManager;
  const route = opts.route === undefined ? null : normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const view = new BrowserView({
    webPreferences: {
      preload: opts.registerWithCodex === false ? undefined : windowManager?.options?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowManager?.options?.allowDevtools,
    },
  });

  if (opts.backgroundColor) {
    callObjectMethod(view, "setBackgroundColor", [opts.backgroundColor]);
    callObjectMethod(asRecord(view)?.webContentsView, "setBackgroundColor", [opts.backgroundColor]);
  }

  const managed: ManagedOwlView = {
    key,
    tweakId: ctx.id,
    id,
    view,
    parentWindowId: windowIdFor(parent),
    attachMode: null,
    disposeBindings: [],
    disposed: false,
  };
  owlViews.set(key, managed);

  try {
    if (route !== null && opts.registerWithCodex !== false && windowManager?.registerWindow) {
      const appearance = opts.appearance || "secondary";
      const windowLike = makeWindowLikeForView(view);
      windowManager.registerWindow(windowLike, hostId, false, appearance);
      services?.getContext?.(hostId)?.registerWindow?.(windowLike);
    }

    attachOwlView(managed, parent);
    if (opts.bounds) setOwlViewBounds(managed, opts.bounds);
    if (opts.visible === false) setOwlViewVisible(managed, false);

    if (route !== null) {
      await view.webContents.loadURL(codexAppUrl(route, hostId));
    } else if (opts.url) {
      await view.webContents.loadURL(normalizeOwlViewUrl(opts.url));
    } else {
      await view.webContents.loadURL("about:blank");
    }
  } catch (e) {
    disposeOwlView(managed);
    throw e;
  }

  log("info", `created Owl view ${ctx.id}:${id}`, {
    parentWindowId: managed.parentWindowId,
    webContentsId: view.webContents.id,
    attachMode: managed.attachMode,
  });
  return owlViewRef(managed);
}

async function callOwlView(
  tweakId: string,
  id: string,
  method: string,
  arg?: unknown,
  arg2?: unknown,
): Promise<unknown> {
  const view = owlViewFor(tweakId, id);
  if (method === "setBounds") return setOwlViewBounds(view, arg as Electron.Rectangle);
  if (method === "setVisible") return setOwlViewVisible(view, Boolean(arg));
  if (method === "bringToFront") return bringOwlViewToFront(view);
  if (method === "loadRoute") {
    const route = normalizeCodexRoute(String(arg));
    const hostId = typeof arg2 === "string" && arg2 ? arg2 : "local";
    return view.view.webContents.loadURL(codexAppUrl(route, hostId));
  }
  if (method === "loadUrl") return view.view.webContents.loadURL(normalizeOwlViewUrl(String(arg)));
  if (method === "dispose") return disposeOwlViewById(tweakId, id);
  throw new Error(`unknown Codex view method: ${method}`);
}

function owlViewRef(view: ManagedOwlView): CodexViewRef {
  return {
    id: view.id,
    webContentsId: view.view.webContents.id,
    parentWindowId: view.parentWindowId,
    setBounds: (bounds) => Promise.resolve(setOwlViewBounds(view, bounds)),
    setVisible: (visible) => Promise.resolve(setOwlViewVisible(view, visible)),
    bringToFront: () => Promise.resolve(bringOwlViewToFront(view)),
    loadRoute: (route, hostId) => view.view.webContents.loadURL(codexAppUrl(normalizeCodexRoute(route), hostId || "local")).then(() => {}),
    loadUrl: (url) => view.view.webContents.loadURL(normalizeOwlViewUrl(url)).then(() => {}),
    dispose: () => Promise.resolve(disposeOwlViewById(view.tweakId, view.id)),
  };
}

function attachOwlView(view: ManagedOwlView, parent: Electron.BrowserWindow): void {
  const contentView = asRecord(parent)?.contentView;
  const webContentsView = asRecord(view.view)?.webContentsView;
  if (typeof asRecord(parent)?.addBrowserView === "function") {
    callObjectMethod(parent, "addBrowserView", [view.view]);
    view.attachMode = "browserView";
  } else if (
    typeof asRecord(contentView)?.addChildView === "function" &&
    webContentsView
  ) {
    try {
      addOwlChildView(parent, view.view);
      view.attachMode = "contentView";
    } catch (e) {
      log("warn", "Owl contentView attachment failed; falling back to BrowserView", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  if (!view.attachMode) {
    throw new Error("Owl view attachment is not available on this Codex window");
  }

  const dispose = () => disposeOwlViewById(view.tweakId, view.id);
  bindWindowEvent(parent, view, "closed", dispose);
  bindWindowEvent(parent, view, "close", dispose);
}

function bringOwlViewToFront(view: ManagedOwlView): void {
  if (view.disposed) return;
  const parent = view.parentWindowId === null ? null : BrowserWindow.fromId(view.parentWindowId);
  if (!parent || isWindowDestroyed(parent)) return;
  const contentView = asRecord(parent)?.contentView;
  const webContentsView = asRecord(view.view)?.webContentsView;
  if (view.attachMode === "contentView" && webContentsView) {
    try {
      if (typeof asRecord(parent)?.setTopBrowserView === "function") {
        callObjectMethod(parent, "setTopBrowserView", [view.view]);
      } else {
        callObjectMethod(contentView, "addChildView", [webContentsView]);
      }
      return;
    } catch (e) {
      log("warn", "Owl contentView bring-to-front failed", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  if (typeof asRecord(parent)?.setTopBrowserView === "function") {
    callObjectMethod(parent, "setTopBrowserView", [view.view]);
  }
}

function setOwlViewBounds(view: ManagedOwlView, bounds: Electron.Rectangle): void {
  assertBounds(bounds);
  callObjectMethod(view.view, "setBounds", [bounds]);
  callObjectMethod(asRecord(view.view)?.webContentsView, "setBounds", [bounds]);
}

function setOwlViewVisible(view: ManagedOwlView, visible: boolean): void {
  callObjectMethod(asRecord(view.view)?.webContentsView, "setVisible", [visible]);
}

function disposeOwlViewById(tweakId: string, id: string): void {
  const view = owlViews.get(owlViewKey(tweakId, id));
  if (!view) return;
  disposeOwlView(view);
}

function disposeOwlViewsForTweak(tweakId: string): void {
  for (const view of [...owlViews.values()]) {
    if (view.tweakId === tweakId) disposeOwlView(view);
  }
}

function disposeAllOwlViews(): void {
  for (const view of [...owlViews.values()]) disposeOwlView(view);
}

function disposeOwlView(view: ManagedOwlView): void {
  if (view.disposed) return;
  view.disposed = true;
  owlViews.delete(view.key);
  for (const dispose of view.disposeBindings.splice(0)) {
    try {
      dispose();
    } catch {}
  }
  const parent = view.parentWindowId === null ? null : BrowserWindow.fromId(view.parentWindowId);
  if (parent && !isWindowDestroyed(parent)) {
    try {
      if (view.attachMode === "contentView") {
        removeOwlChildView(parent, view.view);
      } else if (view.attachMode === "browserView") {
        callObjectMethod(parent, "removeBrowserView", [view.view]);
      }
    } catch (e) {
      log("warn", "Owl view detach failed during dispose", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  try {
    if (!view.view.webContents.isDestroyed()) {
      view.view.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {}
}

function owlViewFor(tweakId: string, id: string): ManagedOwlView {
  const view = owlViews.get(owlViewKey(tweakId, id));
  if (!view || view.disposed) throw new Error(`Codex view is not loaded: ${tweakId}:${id}`);
  return view;
}

function owlViewKey(tweakId: string, viewId: string): string {
  return `${tweakId}:${viewId}`;
}

function addOwlChildView(parent: Electron.BrowserWindow, child: Electron.BrowserView): void {
  const ownerWindow = asRecord(child)?.ownerWindow;
  if (ownerWindow && ownerWindow !== parent) {
    callObjectMethod(ownerWindow, "removeBrowserView", [child]);
  }

  callObjectMethod(asRecord(parent)?.contentView, "addChildView", [asRecord(child)?.webContentsView]);
  try {
    (child as unknown as { ownerWindow: Electron.BrowserWindow | null }).ownerWindow = parent;
  } catch {}
  callObjectMethod(asRecord(child.webContents), "_setOwnerWindow", [parent]);

  const browserViews = asRecord(parent)?._browserViews;
  if (Array.isArray(browserViews) && !browserViews.includes(child)) {
    browserViews.push(child);
  }
}

function removeOwlChildView(parent: Electron.BrowserWindow, child: Electron.BrowserView): void {
  callObjectMethod(asRecord(parent)?.contentView, "removeChildView", [asRecord(child)?.webContentsView]);
  try {
    (child as unknown as { ownerWindow: Electron.BrowserWindow | null }).ownerWindow = null;
  } catch {}

  const browserViews = asRecord(parent)?._browserViews;
  if (Array.isArray(browserViews)) {
    const index = browserViews.indexOf(child);
    if (index >= 0) browserViews.splice(index, 1);
  }
}

async function createCodexBrowserView(opts: CodexCreateViewOptions): Promise<unknown> {
  const services = getCodexWindowServices();
  const windowManager = services?.windowManager;
  if (!services || !windowManager?.registerWindow) {
    throw new Error(
      "Codex embedded view services are not available. Reinstall Codex-DC 1.0.0 or later.",
    );
  }

  const route = normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const appearance = opts.appearance || "secondary";
  const view = new BrowserView({
    webPreferences: {
      preload: windowManager.options?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowManager.options?.allowDevtools,
    },
  });
  const windowLike = makeWindowLikeForView(view);
  windowManager.registerWindow(windowLike, hostId, false, appearance);
  services.getContext?.(hostId)?.registerWindow?.(windowLike);
  await view.webContents.loadURL(codexAppUrl(route, hostId));
  return view;
}

async function createCodexWindow(opts: CodexCreateWindowOptions): Promise<CodexWindowRef> {
  const services = getCodexWindowServices();
  if (!services) {
    throw new Error(
      "Codex window services are not available. Reinstall Codex-DC 1.0.0 or later.",
    );
  }

  const route = normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const parent = typeof opts.parentWindowId === "number"
    ? BrowserWindow.fromId(opts.parentWindowId)
    : BrowserWindow.getFocusedWindow();
  const createWindow = services.windowManager?.createWindow;

  let win: Electron.BrowserWindow | null | undefined;
  if (typeof createWindow === "function") {
    win = await createWindow.call(services.windowManager, {
      initialRoute: route,
      hostId,
      show: opts.show !== false,
      appearance: opts.appearance || "secondary",
      parent,
    });
  } else if (hostId === "local" && typeof services.createFreshWindow === "function") {
    win = await services.createFreshWindow(route);
  } else if (hostId === "local" && typeof services.createFreshLocalWindow === "function") {
    win = await services.createFreshLocalWindow(route);
  } else if (typeof services.ensureHostWindow === "function") {
    win = await services.ensureHostWindow(hostId);
  }

  if (!win || win.isDestroyed()) {
    throw new Error("Codex did not return a window for the requested route");
  }

  if (opts.bounds) {
    win.setBounds(opts.bounds);
  }
  if (parent && !parent.isDestroyed()) {
    try {
      win.setParentWindow(parent);
    } catch {}
  }
  if (opts.show !== false) {
    win.show();
  }

  return {
    windowId: win.id,
    webContentsId: win.webContents.id,
  };
}

function makeCodexApi(tweak: DiscoveredTweak) {
  const ctx = (): NativeTweakContext => ({ id: tweak.manifest.id, dir: tweak.dir });
  return {
    runtime: {
      getInfo: async () => currentRuntimeInfo(),
      getCapabilities: async () => currentRuntimeCapabilities(),
    },
    files: {
      stat: async (path: string) => {
        assertTweakPermission(tweak, "filesystem");
        return statExternalFile(path);
      },
      showInFolder: async (path: string) => {
        assertTweakPermission(tweak, "filesystem");
        return showExternalFileInFolder(path);
      },
    },
    windows: {
      create: createCodexWindow,
      getPrimary: async () => getPrimaryCodexWindowRef(),
      focus: async (windowId: number) => focusCodexWindow(windowId),
      show: async (windowId: number) => showCodexWindow(windowId),
    },
    views: {
      create: async (options: CodexViewCreateOptions) => {
        assertTweakViewPermission(tweak);
        return createOwlView(ctx(), options);
      },
    },
    cdp: {
      getStatus: async () => getCdpStatus(),
      listTargets: async () => listCdpTargets(),
    },
    native: {
      loadModule: async (options: NativeModuleLoadOptions) => {
        assertTweakPermission(tweak, "native-module");
        return nativeBridge.loadModule(ctx(), options);
      },
      createPanel: async (options: NativePanelCreateOptions) => {
        assertTweakPermission(tweak, "native-view");
        return nativeBridge.createPanel(ctx(), options);
      },
      attachView: async (options: NativeViewAttachOptions) => {
        assertTweakPermission(tweak, "native-view");
        return nativeBridge.attachView(ctx(), options);
      },
      launchHelper: async (options: NativeHelperLaunchOptions) => {
        assertTweakPermission(tweak, "native-helper");
        return nativeBridge.launchHelper(ctx(), options);
      },
    },
    createBrowserView: createCodexBrowserView,
    createWindow: createCodexWindow,
  };
}

function makeWindowLikeForView(view: Electron.BrowserView): CodexWindowLike {
  const viewBounds = () => view.getBounds();
  return {
    id: view.webContents.id,
    webContents: view.webContents,
    on: (event: "closed", listener: () => void) => {
      if (event === "closed") {
        view.webContents.once("destroyed", listener);
      } else {
        view.webContents.on(event, listener);
      }
      return view;
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.once(event as "destroyed", listener);
      return view;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.off(event as "destroyed", listener);
      return view;
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.removeListener(event as "destroyed", listener);
      return view;
    },
    isDestroyed: () => view.webContents.isDestroyed(),
    isFocused: () => view.webContents.isFocused(),
    focus: () => view.webContents.focus(),
    show: () => {},
    hide: () => {},
    getBounds: viewBounds,
    getContentBounds: viewBounds,
    getSize: () => {
      const b = viewBounds();
      return [b.width, b.height];
    },
    getContentSize: () => {
      const b = viewBounds();
      return [b.width, b.height];
    },
    setTitle: () => {},
    getTitle: () => "",
    setRepresentedFilename: () => {},
    setDocumentEdited: () => {},
    setWindowButtonVisibility: () => {},
  };
}

function codexAppUrl(route: string, hostId: string): string {
  const url = new URL("app://-/index.html");
  url.searchParams.set("hostId", hostId);
  if (route !== "/") url.searchParams.set("initialRoute", route);
  return url.toString();
}

function normalizeOwlViewUrl(url: string): string {
  if (typeof url !== "string" || url.includes("\n") || url.includes("\r")) {
    throw new Error("Owl view URL must be a string without control characters");
  }
  const parsed = new URL(url);
  if (!["http:", "https:", "app:", "file:", "data:", "about:"].includes(parsed.protocol)) {
    throw new Error(`unsupported Owl view URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function getCodexWindowServices(): CodexWindowServices | null {
  const services = (globalThis as unknown as Record<string, unknown>)[CODEX_WINDOW_SERVICES_KEY];
  return services && typeof services === "object" ? (services as CodexWindowServices) : null;
}

function normalizeCodexRoute(route: string): string {
  if (typeof route !== "string" || !route.startsWith("/")) {
    throw new Error("Codex route must be an absolute app route");
  }
  if (route.includes("://") || route.includes("\n") || route.includes("\r")) {
    throw new Error("Codex route must not include a protocol or control characters");
  }
  return route;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function callObjectMethod(target: unknown, method: string, args: unknown[]): unknown {
  const fn = asRecord(target)?.[method];
  if (typeof fn !== "function") return undefined;
  return fn.apply(target, args);
}

function isWindowDestroyed(win: Electron.BrowserWindow | null | undefined): boolean {
  if (!win) return true;
  const fn = asRecord(win)?.isDestroyed;
  if (typeof fn !== "function") return false;
  try {
    return Boolean(fn.call(win));
  } catch {
    return true;
  }
}

function windowIdFor(win: Electron.BrowserWindow | null | undefined): number | null {
  const id = asRecord(win)?.id;
  return typeof id === "number" ? id : null;
}

function bindWindowEvent(
  win: Electron.BrowserWindow,
  view: ManagedOwlView,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  const on = asRecord(win)?.on;
  const off = asRecord(win)?.off;
  if (typeof on !== "function") return;
  on.call(win, event, listener);
  view.disposeBindings.push(() => {
    if (typeof off === "function") off.call(win, event, listener);
    else callObjectMethod(win, "removeListener", [event, listener]);
  });
}

function assertBridgeId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} may only contain letters, numbers, dots, underscores, and dashes`);
  }
  return value;
}

function assertBounds(bounds: Electron.Rectangle): void {
  const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("bounds must contain finite x, y, width, and height numbers");
  }
  if (bounds.width < 0 || bounds.height < 0) {
    throw new Error("bounds width and height must be non-negative");
  }
}

// Keep BrowserWindow available to the host integration.
void BrowserWindow;
