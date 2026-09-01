import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildMergedCatalog } from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { spawnableCommand } from "../src/codex-binary.mjs";

const binary = process.argv[2];
if (!binary) {
  console.error("Usage: node scripts/check-codex-catalog-compat.mjs PATH_TO_CODEX");
  process.exit(2);
}

function runCodex(args, options = {}) {
  const target = spawnableCommand(binary, args);
  const result = spawnSync(target.command, target.args, {
    ...target.options,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Codex exited ${result.status}`).trim());
  }
  return result.stdout;
}

const version = runCodex(["--version"]).trim();
const native = JSON.parse(runCodex(["debug", "models", "--bundled"]));
const routed = ["openrouter/glm-5.3-flash", "switchyard/auto"].map((slug) => {
  const model = MODEL_BY_SLUG.get(slug);
  if (!model) throw new Error(`Missing checked-in route ${slug}`);
  return model;
});
const catalog = { models: buildMergedCatalog(native, routed) };
const builtSwitchyard = catalog.models.find((model) => model.slug === "switchyard/auto");
if (Object.prototype.hasOwnProperty.call(builtSwitchyard, "auto_compact_token_limit")) {
  throw new Error(`${version} source catalog did not retain Switchyard native compaction`);
}
if (
  !builtSwitchyard.model_messages?.token_budget ||
  !Object.prototype.hasOwnProperty.call(builtSwitchyard.model_messages, "multi_agent")
) {
  throw new Error(`${version} source catalog did not retain current native model-message controls`);
}
const temporaryHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-compat-"));
const catalogPath = path.join(temporaryHome, "merged-models.json");

try {
  writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  const parsed = JSON.parse(
    runCodex(
      ["--config", `model_catalog_json=${JSON.stringify(catalogPath)}`, "debug", "models"],
      { env: { ...process.env, CODEX_HOME: temporaryHome } },
    ),
  );
  const bySlug = new Map(parsed.models.map((model) => [model.slug, model]));
  for (const model of routed) {
    if (!bySlug.has(model.slug)) {
      throw new Error(`${version} did not parse routed catalog entry ${model.slug}`);
    }
  }
  const switchyard = bySlug.get("switchyard/auto");
  if (Object.prototype.hasOwnProperty.call(switchyard, "auto_compact_token_limit")) {
    throw new Error(`${version} did not preserve Switchyard native compaction`);
  }
  if (!switchyard.model_messages?.token_budget) {
    throw new Error(
      `${version} did not preserve current native model-message controls ` +
        `(parsed keys: ${Object.keys(switchyard.model_messages || {}).join(",") || "none"})`,
    );
  }
  process.stdout.write(
    `${version} parsed ${catalog.models.length} models; GLM and Switchyard compatibility passed\n`,
  );
} finally {
  rmSync(temporaryHome, { recursive: true, force: true });
}
