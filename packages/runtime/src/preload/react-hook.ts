import { contextBridge } from "electron";

/**
 * React runs in the page's main world while CodexDC runs in the host's isolated
 * preload world. The main-world bridge serializes the owner chain for a DOM
 * node so renderer tweaks can inspect stable React props without bundle patches.
 */
declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsHook;
    __codexpp__?: {
      hook: ReactDevtoolsHook;
      renderers: Map<number, RendererInternals>;
    };
  }
}

interface RendererInternals {
  findFiberByHostInstance?: (n: Node) => unknown;
  version?: string;
  bundleType?: number;
  rendererPackageName?: string;
}

interface ReactDevtoolsHook {
  supportsFiber: true;
  renderers: Map<number, RendererInternals>;
  on(event: string, fn: (...a: unknown[]) => void): void;
  off(event: string, fn: (...a: unknown[]) => void): void;
  emit(event: string, ...a: unknown[]): void;
  inject(renderer: RendererInternals): number;
  onScheduleFiberRoot?(): void;
  onCommitFiberRoot?(): void;
  onCommitFiberUnmount?(): void;
  checkDCE?(): void;
}

interface FiberSnapshot {
  typeName: string | null;
  hostType: boolean;
  memoizedProps: Record<string, unknown> | null;
  alternateMemoizedProps: Record<string, unknown> | null;
}

interface FiberProjection {
  type: unknown;
  stateNode: null;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: null;
  return: FiberProjection | null;
  child: null;
  sibling: null;
  alternate?: FiberProjection | null;
}

const FIBER_REQUEST_EVENT = "codexpp:react-fiber-request";
const FIBER_RESPONSE_ATTRIBUTE = "data-codexpp-react-fiber-response";

let mainWorldFiberCache = new WeakMap<Element, FiberProjection | null>();
let clearMainWorldFiberCacheScheduled = false;

export function installReactHook(): void {
  installIsolatedWorldHook();
  installMainWorldFiberBridge();
}

function installIsolatedWorldHook(): void {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;

  const renderers = new Map<number, RendererInternals>();
  let nextId = 1;
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const hook: ReactDevtoolsHook = {
    supportsFiber: true,
    renderers,
    inject(renderer) {
      const id = nextId++;
      renderers.set(id, renderer);
      return id;
    },
    on(event, fn) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };

  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: hook,
  });
  window.__codexpp__ = { hook, renderers };
}

function installMainWorldFiberBridge(): void {
  if (typeof contextBridge.executeInMainWorld !== "function") return;

  contextBridge.executeInMainWorld({
    func: (requestEvent: string, responseAttribute: string) => {
      const bridgeKey = "__codexppReactFiberBridgeInstalled__";
      const mainWindow = window as unknown as Record<string, unknown>;
      if (mainWindow[bridgeKey]) return;
      mainWindow[bridgeKey] = true;

      const copyValue = (
        value: unknown,
        depth: number,
        seen: Set<object>,
      ): unknown => {
        if (
          value == null
          || typeof value === "string"
          || typeof value === "number"
          || typeof value === "boolean"
        ) {
          return value;
        }
        if (
          typeof value === "function"
          || typeof value === "symbol"
          || typeof value === "bigint"
          || depth >= 8
        ) {
          return undefined;
        }
        if (Array.isArray(value)) {
          return value.slice(0, 64).map((entry) => copyValue(entry, depth + 1, seen));
        }
        if (typeof value !== "object" || seen.has(value)) {
          return undefined;
        }
        if ("nodeType" in value) {
          return undefined;
        }

        seen.add(value);
        const copy: Record<string, unknown> = {};
        for (const key of Object.keys(value).slice(0, 64)) {
          if (key === "_owner" || key === "_store" || key === "ref") continue;
          const child = (value as Record<string, unknown>)[key];
          if (key === "children" && typeof child === "object") continue;
          const copied = copyValue(child, depth + 1, seen);
          if (copied !== undefined) copy[key] = copied;
        }
        seen.delete(value);
        return copy;
      };

      const typeName = (type: unknown): string | null => {
        if (typeof type === "string") return type;
        if (!type || (typeof type !== "function" && typeof type !== "object")) {
          return null;
        }
        const named = type as { displayName?: unknown; name?: unknown };
        if (typeof named.displayName === "string") return named.displayName;
        if (typeof named.name === "string") return named.name;
        return null;
      };

      document.addEventListener(requestEvent, (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        try {
          const fiberKey = Object.getOwnPropertyNames(target).find(
            (key) =>
              key.startsWith("__reactFiber$")
              || key.startsWith("__reactInternalInstance$"),
          );
          let current = fiberKey
            ? (target as unknown as Record<string, unknown>)[fiberKey]
            : null;
          const snapshots: FiberSnapshot[] = [];

          for (let depth = 0; current && depth < 64; depth += 1) {
            const fiber = current as {
              type?: unknown;
              memoizedProps?: unknown;
              alternate?: { memoizedProps?: unknown } | null;
              return?: unknown;
            };
            const memoizedProps = copyValue(fiber.memoizedProps, 0, new Set());
            const alternateProps = fiber.alternate?.memoizedProps;
            const alternateMemoizedProps = alternateProps === fiber.memoizedProps
              ? null
              : copyValue(alternateProps, 0, new Set());
            snapshots.push({
              typeName: typeName(fiber.type),
              hostType: typeof fiber.type === "string",
              memoizedProps: memoizedProps && typeof memoizedProps === "object"
                ? memoizedProps as Record<string, unknown>
                : null,
              alternateMemoizedProps:
                alternateMemoizedProps && typeof alternateMemoizedProps === "object"
                  ? alternateMemoizedProps as Record<string, unknown>
                  : null,
            });
            current = fiber.return ?? null;
          }

          target.setAttribute(responseAttribute, JSON.stringify(snapshots));
        } catch {
          target.setAttribute(responseAttribute, "[]");
        }
      }, true);
    },
    args: [FIBER_REQUEST_EVENT, FIBER_RESPONSE_ATTRIBUTE],
  });
}

function hydrateFiberSnapshot(snapshots: FiberSnapshot[]): FiberProjection | null {
  let parent: FiberProjection | null = null;

  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (!snapshot) continue;

    const type = snapshot.hostType
      ? snapshot.typeName
      : snapshot.typeName
        ? { displayName: snapshot.typeName, name: snapshot.typeName }
        : null;
    const alternate: FiberProjection | null = snapshot.alternateMemoizedProps
      ? {
        type,
        stateNode: null,
        memoizedProps: snapshot.alternateMemoizedProps,
        memoizedState: null,
        return: parent,
        child: null,
        sibling: null,
      }
      : null;
    parent = {
      type,
      stateNode: null,
      memoizedProps: snapshot.memoizedProps,
      memoizedState: null,
      return: parent,
      child: null,
      sibling: null,
      alternate,
    };
  }

  return parent;
}

function scheduleMainWorldFiberCacheClear(): void {
  if (clearMainWorldFiberCacheScheduled) return;

  clearMainWorldFiberCacheScheduled = true;
  queueMicrotask(() => {
    mainWorldFiberCache = new WeakMap();
    clearMainWorldFiberCacheScheduled = false;
  });
}

function fiberFromMainWorld(node: Node): FiberProjection | null {
  if (!(node instanceof Element)) return null;
  if (mainWorldFiberCache.has(node)) {
    return mainWorldFiberCache.get(node) ?? null;
  }

  node.removeAttribute(FIBER_RESPONSE_ATTRIBUTE);
  node.dispatchEvent(new Event(FIBER_REQUEST_EVENT, { bubbles: true }));
  const response = node.getAttribute(FIBER_RESPONSE_ATTRIBUTE);
  node.removeAttribute(FIBER_RESPONSE_ATTRIBUTE);

  let fiber: FiberProjection | null = null;
  if (response) {
    try {
      const snapshots = JSON.parse(response) as FiberSnapshot[];
      fiber = Array.isArray(snapshots) ? hydrateFiberSnapshot(snapshots) : null;
    } catch {
      fiber = null;
    }
  }

  mainWorldFiberCache.set(node, fiber);
  scheduleMainWorldFiberCacheClear();
  return fiber;
}

/** Resolve the React fiber for a DOM node, including context-isolated pages. */
export function fiberForNode(node: Node): unknown | null {
  const renderers = window.__codexpp__?.renderers;
  if (renderers) {
    for (const renderer of renderers.values()) {
      const fiber = renderer.findFiberByHostInstance?.(node);
      if (fiber) return fiber;
    }
  }

  for (const key of Object.getOwnPropertyNames(node)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return (node as unknown as Record<string, unknown>)[key];
    }
  }

  return fiberFromMainWorld(node);
}
