import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPickerVisibility,
  effectivePickerHiddenModels,
  mergeNativeCatalogs,
  nativeCatalogRefreshNeeded,
  promoteNativeMultiAgent,
  routedModel,
} from "../src/catalog.mjs";
import {
  catalogRefreshIntervalMs,
  refreshCatalogIfStale,
} from "../src/catalog-auto-refresh.mjs";

const template = {
  slug: "gpt-5.5",
  display_name: "GPT-5.5",
  description: "Native template",
  priority: 10,
  visibility: "list",
  base_instructions:
    "You are Codex, a coding agent based on GPT-5. You and the user share one workspace.",
  model_messages: {
    instructions_template:
      "You are Codex, a coding agent based on GPT-5. {{ personality }}",
    instructions_variables: {
      personality_default: "",
    },
  },
  apply_patch_tool_type: "freeform",
  default_service_tier: "priority",
};

const routeFixture = {
  slug: "openrouter/glm-5.3-flash",
  displayName: "GLM-5.3-Flash",
  description: "GLM through OpenRouter",
  priority: 1,
  defaultEffort: "high",
  reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
  contextWindow: 500000,
  autoCompact: 440000,
  inputModalities: ["text", "image"],
  compHash: "openrouter-glm-5-3-flash-test-v1",
  multiAgentVersion: "v2",
  searchTool: { mode: "hosted" },
};

test("external routes do not inherit legacy native summary or parallel-tool flags", () => {
  const native = { ...template, supports_reasoning_summaries: true, supports_parallel_tool_calls: true };
  const model = routedModel(native, routeFixture, native);
  assert.equal(Object.hasOwn(model, "supports_reasoning_summaries"), false);
  assert.equal(Object.hasOwn(model, "supports_parallel_tool_calls"), false);
});

test("signed-in picker overlay cannot hide Codex native base entries", () => {
  const hidden = new Set(["gpt-5.6-luna", "gpt-5.6-sol-1m", "openrouter/glm-5.3-flash"]);
  const native = new Set(["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(
    [...effectivePickerHiddenModels(hidden, native)].sort(),
    ["gpt-5.6-sol-1m", "openrouter/glm-5.3-flash"],
  );
});

test("picker visibility projection hides only unselected routed entries", () => {
  const projected = applyPickerVisibility(
    [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "openrouter/glm-5.3-flash", visibility: "list" },
      { slug: "switchyard/auto", visibility: "list" },
    ],
    {
      nativeBaseSlugs: new Set(["gpt-5.6-sol"]),
      hiddenModels: new Set(["gpt-5.6-sol", "switchyard/auto"]),
      visibleModels: new Set(["openrouter/glm-5.3-flash"]),
      hasExplicitVisibility: true,
    },
  );
  assert.deepEqual(projected.map(({ slug, visibility }) => [slug, visibility]), [
    ["gpt-5.6-sol", "list"],
    ["openrouter/glm-5.3-flash", "list"],
    ["switchyard/auto", "hide"],
  ]);
});

test("Switchyard inherits the native Codex request and compaction contract", () => {
  const behaviorTemplate = {
    ...template,
    slug: "gpt-5.6-sol",
    base_instructions: "You are Codex, an agent based on GPT-5.6. NATIVE_BEHAVIOR",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.6. NATIVE_TEMPLATE",
      collaboration_modes: { default: "native collaboration" },
      permissions: { guidance: "native permissions" },
      multi_agent: { guidance: "native multi-agent" },
      token_budget: { reminder_threshold_tokens: 6144 },
    },
    input_modalities: ["text", "image"],
    context_window: 272000,
    max_context_window: 872000,
    support_verbosity: true,
    default_verbosity: "low",
    supports_search_tool: true,
    supports_image_detail_original: true,
    use_responses_lite: true,
    tool_mode: "code_mode_only",
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: true,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
  };
  const model = routedModel(template, {
    ...routeFixture,
    slug: "switchyard/auto",
    displayName: "Switchyard Auto",
    requestProfile: "switchyard-native",
    inputModalities: ["text"],
    serviceTiers: [
      { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
    ],
    additionalSpeedTiers: ["fast"],
  }, behaviorTemplate);

  assert.equal(model.base_instructions, behaviorTemplate.base_instructions);
  assert.equal(model.model_messages, behaviorTemplate.model_messages);
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.equal(model.context_window, 272000);
  assert.equal(model.max_context_window, 872000);
  assert.equal("auto_compact_token_limit" in model, false);
  for (const limit of [null, 200000]) {
    const inherited = routedModel(template, {
      ...routeFixture, slug: "switchyard/auto", requestProfile: "switchyard-native",
    }, { ...behaviorTemplate, auto_compact_token_limit: limit });
    assert.equal(Object.hasOwn(inherited, "auto_compact_token_limit"), true);
    assert.equal(inherited.auto_compact_token_limit, limit);
  }
  assert.equal("supports_reasoning_summaries" in model, false);
  assert.equal("default_reasoning_summary" in model, false);
  assert.equal(model.support_verbosity, true);
  assert.equal(model.default_verbosity, "low");
  assert.equal(model.supports_search_tool, true);
  assert.equal(model.supports_image_detail_original, true);
  assert.equal("supports_parallel_tool_calls" in model, false);
  assert.equal(model.use_responses_lite, true);
  assert.equal(model.tool_mode, "code_mode_only");
  assert.equal(model.include_skills_usage_instructions, false);
  assert.equal(model.include_plugin_usage_instructions, true);
  assert.equal(model.node_repl_auto_review_required, false);
  assert.equal(model.node_repl_disabled, false);
  assert.deepEqual(model.service_tiers, [
    { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
  ]);
  assert.deepEqual(model.additional_speed_tiers, ["fast"]);
  assert.equal(model.slug, "switchyard/auto");
  assert.equal(model.display_name, "Switchyard Auto");
  assert.deepEqual(model.supported_reasoning_levels, routeFixture.reasoningLevels);
});

test("GLM-5.3-Flash replaces the native prompt with its concise Codex contract", () => {
  const behaviorTemplate = {
    ...template,
    base_instructions: "You are Codex, an agent based on GPT-5.6-Sol. NATIVE",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.6-Sol. NATIVE",
      instructions_variables: { personality_default: "" },
      collaboration_modes: { default: "native collaboration" },
      multi_agent: { guidance: "native multi-agent" },
      token_budget: { reminder_threshold_tokens: 6144 },
    },
  };
  const model = routedModel(template, {
    ...routeFixture,
    displayName: "GLM-5.3-Flash (OpenRouter)",
    instructionProfile: "glm-5.3-flash-codex",
  }, behaviorTemplate);

  assert.match(model.base_instructions, /running on GLM-5\.3-Flash through OpenRouter/);
  assert.equal(model.model_messages.instructions_template, model.base_instructions);
  assert.doesNotMatch(model.base_instructions, /GPT-5/);
  assert.doesNotMatch(model.base_instructions, /Ox/);
  assert.deepEqual(model.model_messages.instructions_variables, { personality_default: "" });
  assert.deepEqual(model.model_messages.collaboration_modes, {
    default: "native collaboration",
  });
  assert.deepEqual(model.model_messages.multi_agent, {
    guidance: "native multi-agent",
  });
  assert.deepEqual(model.model_messages.token_budget, {
    reminder_threshold_tokens: 6144,
  });
  assert.equal(model.supports_search_tool, true);
});

test("routed models are native v2 spawn-agent model overrides", () => {
  const model = routedModel(template, routeFixture);
  assert.equal(model.visibility, "list");
  assert.equal(model.supported_in_api, true);
  assert.equal(model.multi_agent_version, "v2");
});

test("native catalog merge preserves account visibility and bundled-only models", () => {
  const accountMini = {
    slug: "gpt-mini",
    visibility: "list",
    source: "account",
    shell_type: "shell_command",
    model_messages: { instructions_template: "account instructions" },
  };
  const merged = mergeNativeCatalogs(
    {
      models: [
        accountMini,
        {
          slug: "gpt-spark",
          visibility: "list",
          model_messages: { instructions_template: "spark instructions" },
        },
      ],
    },
    {
      models: [
        {
          slug: "gpt-mini",
          visibility: "hide",
          source: "bundled",
          shell_type: "unified_exec",
          base_instructions: "bundled instructions",
        },
        { slug: "gpt-bundled-only", visibility: "list" },
      ],
    },
  );
  assert.deepEqual(merged.models, [
    {
      ...accountMini,
      shell_type: "unified_exec",
      base_instructions: "bundled instructions",
    },
    {
      slug: "gpt-spark",
      visibility: "list",
      model_messages: { instructions_template: "spark instructions" },
      base_instructions: "spark instructions",
    },
    { slug: "gpt-bundled-only", visibility: "list" },
  ]);
});

test("automatic catalog refresh reacts only to native authority changes", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-refresh-"));
  const catalogPath = path.join(testRoot, "native.json");
  const sourcePath = path.join(testRoot, "source.json");
  const source = { version: 1, path: sourcePath, status: "active" };
  const sourceCatalog = { models: [{ slug: "gpt-native", visibility: "list" }] };
  const sourceFingerprint = createHash("sha256")
    .update(JSON.stringify(sourceCatalog.models))
    .digest("hex");
  writeFileSync(sourcePath, `${JSON.stringify(sourceCatalog)}\n`);
  writeFileSync(catalogPath, `${JSON.stringify({
    captured_with: "codex-cli 1.2.3",
    captured_from: "C:\\Codex\\codex.exe",
    captured_binary_fingerprint: "build-a",
    native_source_fingerprint: sourceFingerprint,
    models: sourceCatalog.models,
  })}\n`);
  try {
    assert.equal(nativeCatalogRefreshNeeded({
      catalogPath,
      source,
      currentVersion: "codex-cli 1.2.3",
      currentBinary: "c:\\codex\\CODEX.EXE",
      currentBinaryFingerprint: "build-a",
    }), false);
    assert.equal(nativeCatalogRefreshNeeded({
      catalogPath,
      source,
      currentVersion: "codex-cli 1.2.3",
      currentBinary: "C:\\Codex\\codex.exe",
      currentBinaryFingerprint: "build-b",
    }), true);
    assert.equal(nativeCatalogRefreshNeeded({
      catalogPath,
      source,
      currentVersion: "codex-cli 1.2.4",
      currentBinary: "C:\\Codex\\codex.exe",
    }), true);
    const accountCatalogPath = path.join(testRoot, "account-native.json");
    writeFileSync(accountCatalogPath, `${JSON.stringify({
      captured_with: "codex-cli 1.2.3",
      captured_from: "C:\\Codex\\codex.exe",
      captured_binary_fingerprint: "build-a",
      native_source_fingerprint: "account-a",
      models: sourceCatalog.models,
    })}\n`);
    assert.equal(nativeCatalogRefreshNeeded({
      catalogPath: accountCatalogPath,
      source: null,
      currentVersion: "codex-cli 1.2.3",
      currentBinary: "C:\\Codex\\codex.exe",
      currentBinaryFingerprint: "build-a",
      accountCache: () => ({ fingerprint: "account-a" }),
    }), false);
    assert.equal(nativeCatalogRefreshNeeded({
      catalogPath: accountCatalogPath,
      source: null,
      currentVersion: "codex-cli 1.2.3",
      currentBinary: "C:\\Codex\\codex.exe",
      currentBinaryFingerprint: "build-a",
      accountCache: () => ({ fingerprint: "account-b" }),
    }), true);
    writeFileSync(sourcePath, `${JSON.stringify({ models: [
      ...sourceCatalog.models,
      { slug: "gpt-new", visibility: "list" },
    ] })}\n`);
    assert.equal(nativeCatalogRefreshNeeded({
      catalogPath,
      source,
      currentVersion: "codex-cli 1.2.3",
      currentBinary: "C:\\Codex\\codex.exe",
    }), true);
    assert.deepEqual(
      await refreshCatalogIfStale({
        execute: async () => '{"changed":false,"reason":"native_catalog_current"}\n',
      }),
      { changed: false, reason: "native_catalog_current" },
    );
    assert.equal(catalogRefreshIntervalMs("10000"), 10_000);
    assert.equal(catalogRefreshIntervalMs("9999"), 5 * 60_000);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("configured native catalog refresh applies current bundled schema", {
  skip: process.platform !== "win32",
}, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-native-source-"));
  const codexHome = path.join(testRoot, "codex");
  const state = path.join(codexHome, "codex-router");
  const sourcePath = path.join(testRoot, "source.json");
  const fakeCodex = path.join(testRoot, "codex.cmd");
  const fakeCodexModule = path.join(testRoot, "fake-codex.mjs");
  const sourceCatalog = {
    models: [
      { ...template, shell_type: "shell_command" },
      { ...template, slug: "gpt-5.6-sol", shell_type: "shell_command" },
    ],
  };
  const bundledCatalog = {
    models: sourceCatalog.models.map((model) => ({
      ...model,
      shell_type: "unified_exec",
    })),
  };
  mkdirSync(state, { recursive: true });
  writeFileSync(sourcePath, `${JSON.stringify(sourceCatalog)}\n`);
  writeFileSync(
    path.join(state, "native-catalog-source.json"),
    `${JSON.stringify({ version: 1, path: sourcePath, status: "active" })}\n`,
  );
  writeFileSync(fakeCodex, '@node "%~dp0fake-codex.mjs" %*\r\n');
  writeFileSync(
    fakeCodexModule,
    `if (process.argv[2] === "--version") console.log("codex-cli 0.153.0");\n` +
      `else if (process.argv.slice(2).join(" ") === "debug models --bundled") ` +
      `console.log(${JSON.stringify(JSON.stringify(bundledCatalog))});\n` +
      `else process.exitCode = 2;\n`,
  );
  const program =
    `const { nativeCatalog } = await import(${JSON.stringify(new URL("../src/catalog.mjs", import.meta.url).href)});` +
    `process.stdout.write(JSON.stringify(nativeCatalog({ refreshNative: true })));`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_BIN: fakeCodex,
        CODEX_HOME: codexHome,
        MODEL_ROUTER_STATE_DIR: state,
      },
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const refreshed = JSON.parse(result.stdout);
    assert.deepEqual(
      refreshed.models.map((model) => [model.slug, model.shell_type]),
      [["gpt-5.5", "unified_exec"], ["gpt-5.6-sol", "unified_exec"]],
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("native listed models retain the installed catalog's collaboration capability", () => {
  const native = [
    { slug: "gpt-5.6-terra", visibility: "list", multi_agent_version: "v2" },
    { slug: "gpt-5.6-luna", visibility: "list", multi_agent_version: "v1" },
    { slug: "codex-auto-review", visibility: "hide", multi_agent_version: "v1" },
  ];
  const promoted = promoteNativeMultiAgent(native, {
    mode: "all",
    enabled: [],
    disabled: [],
  });
  assert.equal(promoted[1].multi_agent_version, "v1");
  // Hidden native entries are never advertised as spawn targets.
  assert.equal(promoted[2].multi_agent_version, "v1");
});
