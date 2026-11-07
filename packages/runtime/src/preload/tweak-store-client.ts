/**
 * The live Tweak Store catalog, shared by the Settings pages and the navigation
 * rail. Subscribers learn how many installed tweaks have approved updates, or
 * null while no catalog is loaded.
 */

import type { TweakStoreEntry } from "../tweak-store";

export interface TweakStoreRegistryView {
  schemaVersion: 1;
  generatedAt?: string;
  sourceUrl: string;
  fetchedAt: string;
  entries: TweakStoreEntryView[];
}

export interface TweakStoreEntryView extends TweakStoreEntry {
  installed: {
    version: string;
    enabled: boolean;
    source: "store" | "development" | "manual";
    checkout: string | null;
    status: "update" | "current" | "ahead";
    /** Installed tweaks this entry replaces under its earlier ids. */
    replaces: { name: string; version: string }[];
  } | null;
  platform?: {
    current: string;
    supported: string[] | null;
    compatible: boolean;
    reason: string | null;
  };
  runtime?: {
    current: string;
    required: string | null;
    compatible: boolean;
    reason: string | null;
  };
}

export type StoreUpdateListener = (count: number | null) => void;

export interface TweakStoreClient {
  /** The last loaded catalog, or null before the first load or after a failure. */
  current(): TweakStoreRegistryView | null;
  updateCount(): number | null;
  /** Loads the catalog; concurrent calls share one request unless forced. */
  load(force?: boolean): Promise<TweakStoreRegistryView>;
  /** Records a completed install until the next load confirms it. */
  markInstalled(id: string): void;
  subscribe(listener: StoreUpdateListener): () => void;
}

export function hasStoreUpdate(entry: TweakStoreEntryView): boolean {
  return entry.installed?.status === "update";
}

export function createTweakStoreClient(fetchStore: () => Promise<unknown>): TweakStoreClient {
  let store: TweakStoreRegistryView | null = null;
  let pending: Promise<TweakStoreRegistryView> | null = null;
  const listeners = new Set<StoreUpdateListener>();

  const updateCount = () => (store ? store.entries.filter(hasStoreUpdate).length : null);
  const notify = () => {
    const count = updateCount();
    for (const listener of listeners) listener(count);
  };

  return {
    current: () => store,
    updateCount,
    load(force = false) {
      if (!force) {
        if (store) return Promise.resolve(store);
        if (pending) return pending;
      }
      // Only the latest request updates the catalog.
      const promise: Promise<TweakStoreRegistryView> = fetchStore().then(
        (next) => {
          if (pending === promise) {
            pending = null;
            store = next as TweakStoreRegistryView;
            notify();
          }
          return next as TweakStoreRegistryView;
        },
        (error: unknown) => {
          if (pending === promise) {
            pending = null;
            store = null;
            notify();
          }
          throw error;
        },
      );
      pending = promise;
      return promise;
    },
    markInstalled(id) {
      const entry = store?.entries.find((candidate) => candidate.id === id);
      if (!entry?.installed) return;
      entry.installed = { ...entry.installed, version: entry.manifest.version, status: "current", replaces: [] };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
