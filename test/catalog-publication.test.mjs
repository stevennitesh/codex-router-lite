import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const catalogScript = path.resolve(import.meta.dirname, "..", "src", "catalog.mjs");

function nativeModel(slug) {
  return {
    slug,
    display_name: slug,
    description: "Synthetic native model",
    priority: slug === "gpt-5.5" ? 10 : 20,
    visibility: "list",
    base_instructions: "You are Codex, an agent based on GPT-5.6-Sol.",
    model_messages: {
      instructions_template: "You are Codex, an agent based on GPT-5.6-Sol.",
    },
    input_modalities: ["text", "image"],
    context_window: 300000,
    max_context_window: 900000,
    effective_context_window_percent: 95,
    shell_type: "unified_exec",
    multi_agent_version: "v2",
  };
}

function runCatalog(environment, extra = {}) {
  return spawnSync(process.execPath, [catalogScript, "--refresh-if-stale"], {
    encoding: "utf8",
    env: { ...process.env, ...environment, ...extra },
    windowsHide: true,
  });
}

test("real catalog refresh retries publication and converges optional routes without touching Codex cache", {
  skip: process.platform !== "win32",
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-publication-"));
  const codexHome = path.join(root, "codex");
  const state = path.join(root, "state");
  const agents = path.join(codexHome, "agents");
  const sourcePath = path.join(root, "source.json");
  const authModePath = path.join(root, "auth-mode.txt");
  const fakeCodex = path.join(root, "codex.cmd");
  const fakeCodexModule = path.join(root, "fake-codex.mjs");
  const codexCache = path.join(codexHome, "models_cache.json");
  const mergedPath = path.join(state, "merged-models.json");
  const nativePath = path.join(state, "native-models.json");
  const staleAgent = path.join(agents, "router-model-switchyard-auto.toml");
  const bundledCatalog = { models: [nativeModel("gpt-5.5"), nativeModel("gpt-5.6-sol")] };
  const sourceCatalog = { models: [
    nativeModel("gpt-5.5"),
    { ...nativeModel("gpt-5.6-sol"), visibility: "hide" },
    { ...nativeModel("gpt-5.6-sol"), visibility: "list" },
  ] };
  mkdirSync(agents, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(sourcePath, `${JSON.stringify(sourceCatalog)}\n`);
  writeFileSync(authModePath, "signed-in");
  writeFileSync(codexCache, "codex-owned-sentinel\n");
  writeFileSync(path.join(state, "native-account-models.json"), '{"models":[{}]}\n');
  writeFileSync(
    path.join(state, "native-catalog-source.json"),
    `${JSON.stringify({ version: 1, path: sourcePath, status: "active" })}\n`,
  );
  writeFileSync(
    path.join(state, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["openrouter"] })}\n`,
  );
  writeFileSync(fakeCodex, '@node "%~dp0fake-codex.mjs" %*\r\n');
  writeFileSync(
    fakeCodexModule,
    `import { readFileSync } from "node:fs";\n` +
      `const args = process.argv.slice(2).join(" ");\n` +
      `if (args === "--version") console.log("codex-cli 0.153.0");\n` +
      `else if (args === "debug models --bundled") console.log(${JSON.stringify(JSON.stringify(bundledCatalog))});\n` +
      `else if (args === "login status" && readFileSync(${JSON.stringify(authModePath)}, "utf8").trim() === "signed-in") console.log("Logged in");\n` +
      `else if (args === "login status") { console.error("Not logged in"); process.exitCode = 1; }\n` +
      `else process.exitCode = 2;\n`,
  );
  const environment = {
    CODEX_BIN: fakeCodex,
    CODEX_HOME: codexHome,
    MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_MODEL_PICKER_STATE: path.join(state, "model-picker.json"),
    MODEL_ROUTER_MULTI_AGENT_STATE: path.join(state, "multi-agent-settings.json"),
  };

  try {
    const failed = runCatalog(environment, {
      MODEL_ROUTER_TEST_FAIL_AFTER_CATALOG_WRITE: "1",
    });
    assert.equal(failed.status, 75, failed.stderr);
    assert.equal(existsSync(nativePath), true, "capture completes before forced publication failure");
    assert.equal(existsSync(mergedPath), false, "failed publication rolls back its output");
    const nativeMtime = statSync(nativePath).mtimeMs;

    const recovered = runCatalog(environment);
    assert.equal(recovered.status, 0, recovered.stderr);
    const recoveredResult = JSON.parse(recovered.stdout.trim());
    assert.equal(recoveredResult.changed, true);
    assert.equal(recoveredResult.native_account_refresh, "not-selected");
    assert.equal(
      JSON.parse(readFileSync(mergedPath, "utf8")).models
        .find((model) => model.slug === "gpt-5.6-sol").visibility,
      "hide",
      "the first adopted-source duplicate retains authority over bundled visibility",
    );
    assert.equal(statSync(nativePath).mtimeMs, nativeMtime, "same source capture is reused on retry");
    const mergedMtime = statSync(mergedPath).mtimeMs;

    const unchanged = runCatalog(environment);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    const unchangedResult = JSON.parse(unchanged.stdout.trim());
    assert.equal(unchangedResult.changed, false);
    assert.equal(unchangedResult.reason, "catalog_current");
    assert.equal(statSync(mergedPath).mtimeMs, mergedMtime, "unchanged publication is not rewritten");

    const routedSlugs = [
      "openrouter/glm-5.3-flash",
      "openrouter/glm-5.3-flash-gmicloud",
      "openrouter/pareto",
    ];
    writeFileSync(
      path.join(state, "model-picker.json"),
      `${JSON.stringify({ version: 1, hidden: [], visible: routedSlugs, seeded: routedSlugs })}\n`,
    );
    const visibilityChanged = runCatalog(environment);
    assert.equal(visibilityChanged.status, 0, visibilityChanged.stderr);
    assert.equal(JSON.parse(visibilityChanged.stdout.trim()).changed, true);
    assert.equal(
      JSON.parse(readFileSync(mergedPath, "utf8")).models
        .find((model) => model.slug === routedSlugs[0]).visibility,
      "list",
    );

    writeFileSync(
      path.join(state, "multi-agent-settings.json"),
      `${JSON.stringify({ version: 2, mode: "proven", enabled: [], disabled: ["gpt-5.5"] })}\n`,
    );
    const settingsChanged = runCatalog(environment);
    assert.equal(settingsChanged.status, 0, settingsChanged.stderr);
    const afterSettings = JSON.parse(readFileSync(mergedPath, "utf8"));
    assert.equal(afterSettings.models.find((model) => model.slug === "gpt-5.5").multi_agent_version, "v1");

    writeFileSync(authModePath, "signed-out");
    const authChanged = runCatalog(environment);
    assert.equal(authChanged.status, 0, authChanged.stderr);
    assert.equal(JSON.parse(authChanged.stdout.trim()).native_publication, "preserve");
    assert.equal(
      JSON.parse(readFileSync(mergedPath, "utf8")).models.some((model) => model.slug === "gpt-5.5"),
      true,
      "an unknown live desktop generation retains the prior native publication",
    );
    writeFileSync(authModePath, "signed-in");

    writeFileSync(staleAgent, "stale managed Switchyard agent\n");
    writeFileSync(
      path.join(state, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["switchyard"] })}\n`,
    );
    const invalidOptional = runCatalog(environment);
    assert.equal(invalidOptional.status, 0, invalidOptional.stderr);
    assert.match(invalidOptional.stderr, /routed_model_omitted.*switchyard\/auto/u);
    assert.equal(existsSync(staleAgent), false, "omitted route's generated agent is removed");
    assert.equal(
      JSON.parse(readFileSync(mergedPath, "utf8")).models.some((model) => model.slug === "switchyard/auto"),
      false,
    );

    writeFileSync(staleAgent, "stale managed Switchyard agent\n");
    writeFileSync(
      path.join(state, "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: [] })}\n`,
    );
    const disabledOptional = runCatalog(environment);
    assert.equal(disabledOptional.status, 0, disabledOptional.stderr);
    assert.doesNotMatch(disabledOptional.stderr, /routed_model_omitted/u);
    assert.equal(existsSync(staleAgent), false, "disabled route's generated agent is removed");

    const lastGood = readFileSync(mergedPath, "utf8");
    writeFileSync(sourcePath, '{"models":[{}]}\n');
    const malformedNative = runCatalog(environment);
    assert.notEqual(malformedNative.status, 0);
    assert.equal(readFileSync(mergedPath, "utf8"), lastGood);
    assert.equal(readFileSync(codexCache, "utf8"), "codex-owned-sentinel\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
