import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applyPickerVisibility,
  buildMergedCatalog,
  clampModelEfforts,
  codexEffortVocabulary,
  effectivePickerHiddenModels,
} from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";
import {
  applyMultiAgentCapabilities,
  readMultiAgentSettings,
} from "../src/multi-agent-state.mjs";
import { modelPickerSnapshot, readHiddenModels } from "../src/model-picker-state.mjs";

const binary = process.argv[2];
const installedCatalogPath = process.argv[3] === "--catalog" ? process.argv[4] : undefined;
if (
  !binary ||
  (process.argv.length !== 3 && process.argv.length !== 5) ||
  (process.argv.length === 5 && !installedCatalogPath)
) {
  console.error(
    "Usage: node scripts/check-codex-catalog-compat.mjs PATH_TO_CURRENT_CODEX [--catalog PATH]",
  );
  process.exit(2);
}

function runCodex(binary, args, options = {}) {
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

const routed = [
  "openrouter/glm-5.3-flash",
  "openrouter/glm-5.3-flash-gmicloud",
  "openrouter/union-alpha",
  "switchyard/auto",
].map((slug) => {
  const model = MODEL_BY_SLUG.get(slug);
  if (!model) throw new Error(`Missing checked-in route ${slug}`);
  return model;
});

function buildCandidate(binary, nativeOverride) {
  const version = runCodex(binary, ["--version"]).trim();
  const native = nativeOverride || JSON.parse(runCodex(binary, ["debug", "models", "--bundled"]));
  const hiddenModels = readHiddenModels();
  const pickerState = modelPickerSnapshot();
  const nativeBaseSlugs = new Set(native.models.map((model) => String(model.slug || "")));
  const effectiveHiddenModels = effectivePickerHiddenModels(hiddenModels, nativeBaseSlugs);
  const effectiveRouted = clampModelEfforts(
    applyMultiAgentCapabilities(routed, readMultiAgentSettings(), {
      hidden: hiddenModels,
    }),
    codexEffortVocabulary(version),
  );
  const merged = buildMergedCatalog(native, effectiveRouted);
  const catalog = {
    models: applyPickerVisibility(merged, {
      nativeBaseSlugs,
      hiddenModels: effectiveHiddenModels,
      visibleModels: new Set(pickerState.visible),
      hasExplicitVisibility: pickerState.hasExplicitVisibility,
    }),
  };
  const builtSwitchyard = catalog.models.find((model) => model.slug === "switchyard/auto");
  const builtGlms = routed
    .filter((model) => model.provider === "openrouter")
    .map((model) => catalog.models.find((candidate) => candidate.slug === model.slug));
  const nativeSol = native.models.find((model) => model.slug === "gpt-5.6-sol");

  assert.equal(Object.hasOwn(builtSwitchyard, "auto_compact_token_limit"),
    Object.hasOwn(nativeSol, "auto_compact_token_limit"), `${version} changed native compaction presence`);
  assert.equal(builtSwitchyard.auto_compact_token_limit, nativeSol.auto_compact_token_limit,
    `${version} changed native compaction value`);
  assert.deepEqual(
    builtSwitchyard.model_messages,
    nativeSol.model_messages,
    `${version} lost native Sol model_messages`,
  );
  for (const field of [
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "node_repl_auto_review_required",
    "node_repl_disabled",
  ]) {
    if (Object.prototype.hasOwnProperty.call(nativeSol, field)) {
      assert.deepEqual(
        builtSwitchyard[field],
        nativeSol[field],
        `${version} lost native Sol ${field}`,
      );
    }
  }
  for (const builtGlm of builtGlms) {
    assert.equal(builtGlm.supports_reasoning_summary_parameter, false);
    assert.equal("supports_reasoning_summaries" in builtGlm, false);
    assert.equal("supports_parallel_tool_calls" in builtGlm, false);
    assert.deepEqual(builtGlm.experimental_supported_tools, []);
    assert.equal("multi_agent_reasoning_effort" in builtGlm, false);
  }
  return { binary, version, catalog };
}

const installedNative = installedCatalogPath
  ? JSON.parse(readFileSync(path.join(path.dirname(installedCatalogPath), "native-models.json"), "utf8"))
  : undefined;
const source = buildCandidate(binary, installedNative);
const temporaryHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-compat-"));
const catalogPath = installedCatalogPath || path.join(temporaryHome, "merged-models.json");
try {
  const checkedCatalog = installedCatalogPath
    ? JSON.parse(readFileSync(installedCatalogPath, "utf8"))
    : source.catalog;
  if (!installedCatalogPath) {
    writeFileSync(catalogPath, `${JSON.stringify(checkedCatalog)}\n`);
  }
  const checkedBySlug = new Map(checkedCatalog.models?.map((model) => [model.slug, model]) || []);
  const expectedBySlug = new Map(source.catalog.models.map((model) => [model.slug, model]));
  const routeOwnedFields = (model) => {
    const { availability_nux: _announcementState, ...owned } = model;
    return owned;
  };
  for (const model of routed) {
    if (!checkedBySlug.has(model.slug)) {
      throw new Error(`${source.version} catalog is missing routed entry ${model.slug}`);
    }
    assert.deepEqual(
      routeOwnedFields(checkedBySlug.get(model.slug)),
      routeOwnedFields(expectedBySlug.get(model.slug)),
      `${source.version} installed routed entry ${model.slug} does not match the candidate`,
    );
  }
  const parsed = JSON.parse(
    runCodex(
      source.binary,
      ["--config", `model_catalog_json=${JSON.stringify(catalogPath)}`, "debug", "models"],
      { env: { ...process.env, CODEX_HOME: temporaryHome } },
    ),
  );
  const bySlug = new Map(parsed.models.map((model) => [model.slug, model]));
  for (const model of routed) {
    if (!bySlug.has(model.slug)) {
      throw new Error(`${source.version} did not parse routed catalog entry ${model.slug}`);
    }
  }
  const switchyard = bySlug.get("switchyard/auto");
  assert.equal(switchyard.auto_compact_token_limit ?? undefined,
    expectedBySlug.get("switchyard/auto").auto_compact_token_limit ?? undefined,
    `${source.version} did not preserve Switchyard native compaction`);
  process.stdout.write(
    `${source.version} parsed ${checkedCatalog.models.length} current-schema models; ` +
      "GLM, Union Alpha, and Switchyard compatibility passed\n",
  );
} finally {
  rmSync(temporaryHome, { recursive: true, force: true });
}
