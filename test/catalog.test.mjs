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
  buildMergedCatalog,
  effectivePickerHiddenModels,
  mergeNativeCatalogs,
  nativeCatalogRefreshNeeded,
  promoteNativeMultiAgent,
  routedModel,
} from "../src/catalog.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
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
  supportsToolSearch: true,
  searchTool: { mode: "hosted" },
};

test("deferred tool discovery is independent of hosted web search", () => {
  for (const supportsToolSearch of [false, true]) {
    for (const searchTool of [undefined, { mode: "hosted" }]) {
      const model = routedModel(template, { ...routeFixture, supportsToolSearch, searchTool });
      assert.equal(model.supports_search_tool, supportsToolSearch);
    }
  }
});

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

function switchyardNative(slug, overrides = {}) {
  return {
    ...template,
    slug,
    base_instructions: "You are Codex, an agent based on GPT-5.6-Sol. SOL_BEHAVIOR",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.6-Sol. SOL_TEMPLATE",
      collaboration_modes: { default: "native collaboration" },
      token_budget: { reminder_threshold_tokens: 6144 },
    },
    input_modalities: ["text", "image"],
    context_window: 300000,
    max_context_window: 900000,
    effective_context_window_percent: 95,
    support_verbosity: true,
    supports_search_tool: true,
    supports_parallel_tool_calls: true,
    web_search_tool_type: "text_and_image",
    supports_image_detail_original: true,
    use_responses_lite: true,
    tool_mode: "code_mode_only",
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    experimental_supported_tools: ["shared"],
    additional_speed_tiers: ["fast"],
    service_tiers: [{ id: "priority", name: "Fast" }],
    ...overrides,
  };
}

function mergedSwitchyard(nativeOverrides = {}) {
  const native = {
    models: [
      switchyardNative("gpt-5.6-luna", {
        context_window: 272000,
        max_context_window: 872000,
        ...nativeOverrides.luna,
      }),
      switchyardNative("gpt-5.6-sol", {
        service_tiers: [
          { id: "priority", name: "Fast" },
          { id: "ultrafast", name: "Ultrafast" },
        ],
        ...nativeOverrides.sol,
      }),
      switchyardNative("gpt-6-astra", {
        context_window: 280000,
        max_context_window: 880000,
        effective_context_window_percent: 90,
        input_modalities: ["text"],
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        supports_parallel_tool_calls: false,
        node_repl_auto_review_required: true,
        experimental_supported_tools: ["shared", "clock"],
        multi_agent_reasoning_effort: "xhigh",
        ...nativeOverrides.astra,
      }),
    ],
  };
  return buildMergedCatalog(native, [MODEL_BY_SLUG.get("switchyard/auto")])
    .find((model) => model.slug === "switchyard/auto");
}

test("Switchyard publishes the common native contract with neutral Sol instructions", () => {
  const model = mergedSwitchyard();
  assert.match(model.base_instructions, /^You are Codex, a routed coding agent\. SOL_BEHAVIOR/u);
  assert.match(
    model.model_messages.instructions_template,
    /^You are Codex, a routed coding agent\. SOL_TEMPLATE/u,
  );
  assert.deepEqual(model.model_messages.collaboration_modes, { default: "native collaboration" });
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.deepEqual(model.experimental_supported_tools, ["shared"]);
  assert.equal(model.context_window, 272000);
  assert.equal(model.max_context_window, 872000);
  assert.equal(model.effective_context_window_percent, 90);
  assert.equal("auto_compact_token_limit" in model, false);
  assert.equal(model.include_plugin_usage_instructions, false);
  assert.equal(model.include_apps_usage_instructions, false);
  assert.equal(model.node_repl_auto_review_required, true);
  assert.equal(model.node_repl_disabled, false);
  assert.equal(model.supports_parallel_tool_calls, false);
  assert.equal(model.web_search_tool_type, "text_and_image");
  assert.equal("multi_agent_reasoning_effort" in model, false);
  assert.deepEqual(model.service_tiers, [
    { id: "priority", name: "Fast", description: "Faster processing, increased usage" },
  ]);
  assert.deepEqual(model.additional_speed_tiers, ["fast"]);
});

test("Switchyard conservatively projects nullable tools and common tiers", () => {
  const nullablePatch = mergedSwitchyard({
    luna: { apply_patch_tool_type: null },
    sol: { apply_patch_tool_type: null },
    astra: { apply_patch_tool_type: null },
  });
  assert.equal(Object.hasOwn(nullablePatch, "apply_patch_tool_type"), true);
  assert.equal(nullablePatch.apply_patch_tool_type, null);

  const differentSearch = mergedSwitchyard({
    astra: { web_search_tool_type: "text" },
  });
  assert.equal(differentSearch.supports_search_tool, true);
  assert.equal(differentSearch.web_search_tool_type, "text");

  const fallbackSearch = mergedSwitchyard({
    luna: { web_search_tool_type: undefined },
    sol: { web_search_tool_type: null },
    astra: { web_search_tool_type: "text" },
  });
  assert.equal(fallbackSearch.supports_search_tool, true);
  assert.equal(fallbackSearch.web_search_tool_type, "text");

  const noDeferredDiscovery = mergedSwitchyard({
    astra: { supports_search_tool: false },
  });
  assert.equal(noDeferredDiscovery.supports_search_tool, false);
  assert.equal(noDeferredDiscovery.web_search_tool_type, "text_and_image");

  const noCommonFast = mergedSwitchyard({
    astra: { additional_speed_tiers: [], service_tiers: [] },
  });
  assert.deepEqual(noCommonFast.additional_speed_tiers, []);
  assert.deepEqual(noCommonFast.service_tiers, []);
});

test("Switchyard reconciles absent, null, and explicit native compaction limits", () => {
  assert.equal("auto_compact_token_limit" in mergedSwitchyard(), false);
  assert.equal(mergedSwitchyard({
    luna: { auto_compact_token_limit: null },
    sol: { auto_compact_token_limit: null },
    astra: { auto_compact_token_limit: null },
  }).auto_compact_token_limit, null);
  assert.equal(mergedSwitchyard({
    luna: { auto_compact_token_limit: 220000 },
    sol: { auto_compact_token_limit: null },
    astra: { auto_compact_token_limit: 210000 },
  }).auto_compact_token_limit, 210000);
});

test("Switchyard rejects missing or incompatible native compatibility members", () => {
  assert.throws(
    () => buildMergedCatalog({ models: [
      switchyardNative("gpt-5.6-luna"),
      switchyardNative("gpt-5.6-sol"),
    ] }, [MODEL_BY_SLUG.get("switchyard/auto")]),
    /missing compatibility model gpt-6-astra/u,
  );
  assert.throws(
    () => mergedSwitchyard({ astra: { tool_mode: "different" } }),
    /requires compatible tool_mode/u,
  );
  assert.throws(
    () => mergedSwitchyard({ astra: { context_window: undefined } }),
    /requires valid context_window/u,
  );
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

test("external recovery guidance reaches both prompt surfaces without duplication or native mutation", () => {
  const original = structuredClone(template);
  const first = routedModel(template, routeFixture);
  for (const text of [first.base_instructions, first.model_messages.instructions_template]) {
    assert.match(text, /Changing the command timeout does not repair a setup failure/);
    assert.match(text, /actually starts and times out is a different case/);
    assert.equal(text.split("## Tool failure recovery").length, 2);
  }
  const second = routedModel(first, routeFixture);
  assert.equal(second.base_instructions.split("## Tool failure recovery").length, 2);
  assert.equal(second.model_messages.instructions_template.split("## Tool failure recovery").length, 2);
  assert.deepEqual(template, original);
});
