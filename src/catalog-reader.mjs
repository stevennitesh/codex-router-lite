import { readFileSync, statSync } from "node:fs";

function identity(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

// Catalog publication can replace or rewrite this file while Router is running.
// Cache parsed data only for one observed file generation, never by a time TTL.
export function createCatalogReader(filePath) {
  let cachedIdentity;
  let cachedModels;
  return () => {
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = identity(statSync(filePath, { bigint: true }));
        if (before === cachedIdentity) return cachedModels;
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        const after = identity(statSync(filePath, { bigint: true }));
        if (before !== after) continue;
        cachedIdentity = after;
        cachedModels = Array.isArray(parsed?.models) ? parsed.models : [];
        return cachedModels;
      }
    } catch {
      // Missing, unreadable, and incomplete state must not retain stale
      // effort metadata.
    }
    cachedIdentity = undefined;
    cachedModels = undefined;
    return [];
  };
}
