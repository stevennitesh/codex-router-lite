import path from "node:path";
import { fileURLToPath } from "node:url";

const NON_RUNTIME_FILE = /^(?:docs|test|v2_agent)\//u;
const NON_RUNTIME_BASENAME = /^(?:LICENSE|NOTICE(?:\.md)?)$/u;

export function classifyDeploymentChange({ paths = [], knownCatalogPublication = false } = {}) {
  if (knownCatalogPublication) {
    return paths.length ? "runtime" : "catalog-only";
  }
  if (!paths.length) return "no-op";
  const normalized = paths.map((value) => String(value).replaceAll("\\", "/"));
  return normalized.every((value) => NON_RUNTIME_FILE.test(value) || NON_RUNTIME_BASENAME.test(value))
    ? "documentation-only"
    : "runtime";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const knownCatalogPublication = args[0] === "--known-catalog-publication";
  const paths = knownCatalogPublication ? args.slice(1) : args;
  process.stdout.write(`${classifyDeploymentChange({ paths, knownCatalogPublication })}\n`);
}
