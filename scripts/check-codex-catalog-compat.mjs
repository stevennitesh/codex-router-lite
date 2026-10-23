import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyPickerVisibility,
  buildMergedCatalog,
  clampModelEfforts,
  codexEffortVocabulary,
  effectivePickerHiddenModels,
  omittedSwitchyardNativeFields,
} from "../src/catalog.mjs";
import { CHECKED_IN_MODELS, MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { findCodexBinary } from "../src/codex-binary.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";
import {
  applyMultiAgentCapabilities,
  readMultiAgentSettings,
} from "../src/multi-agent-state.mjs";
import { modelPickerSnapshot, readHiddenModels } from "../src/model-picker-state.mjs";
import {
  readSwitchyardConfigContract,
  validateSwitchyardConfigContract,
} from "./switchyard-config-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runCodex(binary, args, options = {}) {
  const operation = args[0] === "--version" ? "version" : args[0] === "--config" ? "parse" : "bundled";
  let result;
  try {
    const target = spawnableCommand(binary, args);
    result = spawnSync(target.command, target.args, {
      ...target.options,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  } catch {
    throw new Error(`Codex ${operation} probe failed: invocation rejected.`);
  }
  if (result.error || result.signal || result.status !== 0) {
    const reason = result.error?.code === "ENOBUFS" ? "output limit exceeded"
      : result.error?.code === "ETIMEDOUT" ? "timeout"
      : result.error ? "could not start or capture command"
      : result.signal ? "command terminated"
      : Number.isInteger(result.status) ? `exit status ${result.status}` : "no exit status";
    // Neither stream nor exception text is safe diagnostic metadata.
    throw new Error(`Codex ${operation} probe failed: ${reason}.`);
  }
  return result.stdout;
}

function parseCodexJson(output) {
  try { return JSON.parse(output); }
  catch { throw new Error("Codex catalog probe failed: invalid JSON."); }
}

const routed = CHECKED_IN_MODELS;

function buildCandidate(binary, nativeOverride) {
  const version = runCodex(binary, ["--version"]).trim();
  const native = nativeOverride || parseCodexJson(runCodex(binary, ["debug", "models", "--bundled"]));
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
  const omittedRoutes = [];
  const merged = buildMergedCatalog(native, effectiveRouted, { omittedRoutes });
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
  const switchyardOmission = omittedRoutes.find((model) => model.slug === "switchyard/auto");
  if (!builtSwitchyard) {
    assert.ok(nativeOverride && switchyardOmission,
      `${version} cannot publish Switchyard: ${switchyardOmission?.reason || "missing routed entry"}`);
    console.warn(JSON.stringify({ warning: "routed_model_omitted", ...switchyardOmission }));
  } else {
    assertSwitchyardCompatibility(native, builtSwitchyard, version);
  }
  for (const builtGlm of builtGlms) {
    assert.equal(builtGlm.supports_reasoning_summary_parameter, false);
    assert.equal("supports_reasoning_summaries" in builtGlm, false);
    assert.equal("supports_parallel_tool_calls" in builtGlm, false);
    assert.equal(builtGlm.supports_reasoning_effort_updates, false);
    assert.deepEqual(builtGlm.experimental_supported_tools, []);
    assert.equal("multi_agent_reasoning_effort" in builtGlm, false);
  }
  return { binary, version, catalog, switchyardOmission };
}

function assertSwitchyardCompatibility(native, builtSwitchyard, version) {
  const switchyardRoute = MODEL_BY_SLUG.get("switchyard/auto");
  const compatibilityMembers = switchyardRoute.compatibilityModels.map((slug) => {
    const member = native.models.find((model) => model.slug === slug);
    assert.ok(member, `${version} is missing Switchyard compatibility model ${slug}`);
    return member;
  });
  const nativeSol = compatibilityMembers.find((model) => model.slug === switchyardRoute.upstreamModel);
  const omittedNativeFields = omittedSwitchyardNativeFields(
    compatibilityMembers,
    builtSwitchyard,
  );
  if (omittedNativeFields.total) {
    console.warn(JSON.stringify({
      warning: "switchyard_native_fields_omitted",
      fields: omittedNativeFields.fields,
      total: omittedNativeFields.total,
    }));
  }
  const commonArray = (field) => compatibilityMembers.slice(1).reduce(
    (values, member) => values.filter((value) => (member[field] || []).includes(value)),
    [...(compatibilityMembers[0][field] || [])],
  );
  assert.deepEqual(builtSwitchyard.input_modalities, commonArray("input_modalities"));
  assert.deepEqual(
    builtSwitchyard.experimental_supported_tools,
    commonArray("experimental_supported_tools"),
  );
  assert.equal(
    builtSwitchyard.context_window,
    Math.min(...compatibilityMembers.map((model) => model.context_window)),
  );
  assert.equal(
    builtSwitchyard.max_context_window,
    Math.min(...compatibilityMembers.map((model) => model.max_context_window)),
  );
  assert.equal(
    builtSwitchyard.effective_context_window_percent,
    Math.min(...compatibilityMembers.map((model) => model.effective_context_window_percent)),
  );
  assert.equal(
    builtSwitchyard.node_repl_auto_review_required,
    compatibilityMembers.some((model) => model.node_repl_auto_review_required === true),
  );
  assert.equal(
    builtSwitchyard.supports_parallel_tool_calls,
    compatibilityMembers.every((model) => model.supports_parallel_tool_calls === true),
  );
  const webSearchToolTypes = compatibilityMembers.map(
    (model) => model.web_search_tool_type ?? "text",
  );
  const commonWebSearchToolType = webSearchToolTypes.every(
    (value) => value === "text_and_image",
  ) ? "text_and_image" : "text";
  assert.equal(builtSwitchyard.web_search_tool_type, commonWebSearchToolType);
  assert.equal("multi_agent_reasoning_effort" in builtSwitchyard, false);
  for (const field of [
    "default_reasoning_summary",
    "default_verbosity",
    "shell_type",
    "truncation_policy",
  ]) {
    assert.deepEqual(
      builtSwitchyard[field],
      compatibilityMembers[0][field],
      `${version} did not preserve common Switchyard ${field}`,
    );
  }
  for (const field of [
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "supports_search_tool",
    "supports_reasoning_effort_updates",
    "supports_image_detail_original",
    "use_responses_lite",
  ]) {
    assert.equal(
      builtSwitchyard[field],
      compatibilityMembers.every((model) => model[field] === true),
      `${version} published incompatible Switchyard ${field}`,
    );
  }
  const compactValues = compatibilityMembers
    .filter((model) => Object.hasOwn(model, "auto_compact_token_limit"))
    .map((model) => model.auto_compact_token_limit)
    .filter((value) => value !== null);
  const compactPresent = compatibilityMembers.some(
    (model) => Object.hasOwn(model, "auto_compact_token_limit"),
  );
  assert.equal(Object.hasOwn(builtSwitchyard, "auto_compact_token_limit"), compactPresent);
  if (compactPresent) {
    assert.equal(
      builtSwitchyard.auto_compact_token_limit,
      compactValues.length ? Math.min(...compactValues) : null,
    );
  }
  const nativeIdentity = /^You are Codex, an agent based on GPT-\d+(?:\.\d+)*(?:[-\s][A-Za-z0-9]+)?\./u;
  const neutralIdentity = "You are Codex, a routed coding agent.";
  assert.equal(
    builtSwitchyard.base_instructions,
    nativeSol.base_instructions.replace(nativeIdentity, neutralIdentity),
    `${version} changed more than the native Sol identity sentence`,
  );
  assert.deepEqual(
    builtSwitchyard.model_messages,
    {
      ...nativeSol.model_messages,
      instructions_template: nativeSol.model_messages.instructions_template.replace(
        nativeIdentity,
        neutralIdentity,
      ),
    },
    `${version} changed more than the native Sol model_messages identity`,
  );

  const switchyardContract = validateSwitchyardConfigContract(
    readSwitchyardConfigContract(repositoryRoot),
  );
  for (const target of switchyardContract.answers) {
    const supported = native.models.find((model) => model.slug === target.model)
      ?.supported_reasoning_levels?.some((level) => level.effort === target.effort);
    assert.equal(
      supported,
      true,
      `${version} does not support ${target.model} ${target.effort} for ${target.name}`,
    );
  }
}

export function main(args = process.argv.slice(2)) {
  const binary = args[0] === "--current" ? findCodexBinary() : args[0];
  const installedCatalogPath = args[1] === "--catalog" ? args[2] : undefined;
  if (!binary || (args.length !== 1 && args.length !== 3) || (args.length === 3 && !installedCatalogPath)) {
    console.error("Usage: node scripts/check-codex-catalog-compat.mjs PATH_TO_CURRENT_CODEX|--current [--catalog PATH]");
    process.exitCode = 2;
    return;
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
      if (model.slug === source.switchyardOmission?.slug) {
        assert.equal(checkedBySlug.has(model.slug), false,
          `${source.version} installed catalog advertises incompatible routed entry ${model.slug}`);
        continue;
      }
      if (!checkedBySlug.has(model.slug)) {
        throw new Error(`${source.version} catalog is missing routed entry ${model.slug}`);
      }
      assert.deepEqual(
        routeOwnedFields(checkedBySlug.get(model.slug)),
        routeOwnedFields(expectedBySlug.get(model.slug)),
        `${source.version} installed routed entry ${model.slug} does not match the candidate`,
      );
    }
    const parsed = parseCodexJson(
      runCodex(
        source.binary,
        ["--config", `model_catalog_json=${JSON.stringify(catalogPath)}`, "debug", "models"],
        { env: { ...process.env, CODEX_HOME: temporaryHome } },
      ),
    );
    const bySlug = new Map(parsed.models.map((model) => [model.slug, model]));
    for (const model of routed) {
      if (model.slug === source.switchyardOmission?.slug) {
        assert.equal(bySlug.has(model.slug), false,
          `${source.version} parsed catalog advertises incompatible routed entry ${model.slug}`);
        continue;
      }
      if (!bySlug.has(model.slug)) {
        throw new Error(`${source.version} did not parse routed catalog entry ${model.slug}`);
      }
    }
    const switchyard = bySlug.get("switchyard/auto");
    if (switchyard) {
      assert.equal(switchyard.auto_compact_token_limit ?? undefined,
        expectedBySlug.get("switchyard/auto").auto_compact_token_limit ?? undefined,
        `${source.version} did not preserve Switchyard native compaction`);
    }
    process.stdout.write(
      `${source.version} parsed ${checkedCatalog.models.length} current-schema models; ` +
        (source.switchyardOmission
          ? "GLM, DeepSeek, and Pareto compatibility passed; Switchyard safely omitted\n"
          : "GLM, DeepSeek, Pareto, and Switchyard compatibility passed\n"),
    );
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
