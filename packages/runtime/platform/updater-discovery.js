"use strict";

function isUpdaterManager(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.appUpdates &&
      typeof value.appUpdates.getIsUpdateReady === "function" &&
      typeof value.appUpdates.installUpdatesIfAvailable === "function",
  );
}

function findUpdaterSharedState(exportsValue) {
  if (!exportsValue || (typeof exportsValue !== "object" && typeof exportsValue !== "function")) {
    return null;
  }

  const candidates = [exportsValue];
  if (exportsValue.default && exportsValue.default !== exportsValue) {
    candidates.push(exportsValue.default);
  }

  for (const candidate of candidates) {
    for (const key of Object.getOwnPropertyNames(candidate)) {
      let factory;
      try {
        factory = candidate[key];
      } catch {
        continue;
      }
      if (typeof factory !== "function") continue;
      // Chunk exports also contain async startup routines with the same anchors.
      // Only synchronous singleton factories can provide the updater manager.
      if (Object.prototype.toString.call(factory) !== "[object Function]") continue;
      const source = Function.prototype.toString.call(factory);
      if (!hasUpdaterAnchors(source)) {
        continue;
      }
      try {
        const sharedState = factory();
        if (isUpdaterManager(sharedState)) return sharedState;
      } catch {
        // Ignore unrelated exports that happen to contain the semantic anchors.
      }
    }
  }
  return null;
}

function hasUpdaterAnchors(source) {
  return source.includes("appUpdates") && source.includes("setSparkleBridgeHandlers");
}

function createUpdaterObserver(onSharedState) {
  const observedTables = new WeakSet();
  const wrappers = [];
  let active = true;

  const inspect = loaded => {
    if (!active) return;
    const shared = findUpdaterSharedState(loaded);
    if (shared) onSharedState(shared);

    // Rspack chunks export module definitions. Observe their exports only when
    // the bundler executes them, before control returns to an importing module.
    const table = loaded?.modules;
    if (!table || typeof table !== "object" || observedTables.has(table)) return;
    observedTables.add(table);
    for (const [key, factory] of Object.entries(table)) {
      if (typeof factory !== "function" || !hasUpdaterAnchors(Function.prototype.toString.call(factory))) continue;
      const wrapped = function(module, ...args) {
        const result = factory.call(this, module, ...args);
        if (active) inspect(module.exports);
        return result;
      };
      table[key] = wrapped;
      wrappers.push({ table, key, factory, wrapped });
    }
  };

  return {
    inspect,
    stop() {
      active = false;
      for (const { table, key, factory, wrapped } of wrappers) {
        if (table[key] === wrapped) table[key] = factory;
      }
      wrappers.length = 0;
    },
  };
}

function isUpdaterModulePath(value) {
  return /(?:^|[/\\])(?:early-)?bootstrap(?:-[^/\\]+)?\.js$/i.test(String(value));
}


module.exports = { findUpdaterSharedState, createUpdaterObserver, isUpdaterModulePath };
