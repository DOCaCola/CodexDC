"use strict";

function isUpdaterManager(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.sparkleManager &&
      typeof value.sparkleManager.getIsUpdateReady === "function" &&
      typeof value.sparkleManager.installUpdatesIfAvailable === "function",
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
      const source = Function.prototype.toString.call(factory);
      if (!source.includes("sparkleManager") || !source.includes("setSparkleBridgeHandlers")) {
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

function isUpdaterModulePath(value) {
  return /(?:^|[/\\])(?:window-all-closed|bootstrap)-[^/\\]+\.js$/i.test(String(value));
}


module.exports = { findUpdaterSharedState, isUpdaterModulePath };
