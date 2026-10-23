import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCodex } from "../scripts/check-codex-catalog-compat.mjs";
import { CHECKED_IN_MODELS } from "../src/routed-models.mjs";
import { applyPickerVisibility, buildMergedCatalog, clampModelEfforts, codexEffortVocabulary } from "../src/catalog.mjs";
import { applyMultiAgentCapabilities } from "../src/multi-agent-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const canary = "synthetic-private-capture-canary";

test("Codex probe rejects bounded capture failures without stream or exception text", () => {
  assert.equal(runCodex(process.execPath, ["--version"]).trim(), process.version);
  for (const stream of ["stdout", "stderr"]) {
    assert.throws(() => runCodex(process.execPath, ["-e", `process.${stream}.write(${JSON.stringify(canary)});process.exitCode=17;`]), error => {
      assert.match(error.message, /exit status 17/u);
      assert.doesNotMatch(error.message, /synthetic-private-capture-canary/u);
      return true;
    });
  }
  assert.throws(() => runCodex(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(canary)});process.stdout.write(Buffer.alloc(33*1024*1024,120));`]), error => {
    assert.match(error.message, /output limit exceeded/u);
    assert.doesNotMatch(error.message, /synthetic-private-capture-canary/u);
    return true;
  });
  assert.throws(() => runCodex(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 }), /probe failed: timeout/u);
  assert.throws(() => runCodex(path.join(os.tmpdir(), `${canary}-missing.exe`), ["--version"]), error => {
    assert.match(error.message, /could not start or capture command/u);
    assert.doesNotMatch(error.message, /synthetic-private-capture-canary/u);
    return true;
  });
});

test("compatibility CLI accepts above-default catalogs and retains strict failure and cleanup controls", { skip: process.platform !== "win32" }, t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router catalog fixture "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = "codex-cli 0.134.0-alpha.21";
  const base = {
    slug: "gpt-5.5", display_name: "Fixture", description: "Synthetic native model", priority: 1, visibility: "list",
    base_instructions: "You are Codex, an agent based on GPT-6.1. Synthetic instructions.",
    model_messages: { instructions_template: "You are Codex, an agent based on GPT-6.1. {{ personality }}", instructions_variables: { personality_default: "" } },
    input_modalities: ["text", "image"], context_window: 300000, max_context_window: 900000,
    effective_context_window_percent: 95, default_reasoning_summary: "none", default_verbosity: "low",
    shell_type: "unified_exec", truncation_policy: { mode: "tokens", limit: 10000 },
    support_verbosity: true, supports_search_tool: true, supports_reasoning_effort_updates: false,
    supports_parallel_tool_calls: true, web_search_tool_type: "text_and_image",
    supports_image_detail_original: true, use_responses_lite: true, tool_mode: "code_mode_only",
    include_skills_usage_instructions: false, include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true, node_repl_auto_review_required: false, node_repl_disabled: false,
    experimental_supported_tools: ["shared"], additional_speed_tiers: ["fast"],
    service_tiers: [{ id: "priority", name: "Fast" }], auto_compact_token_limit: 244800,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => ({ effort, description: effort })),
  };
  const slugs = [...new Set(["gpt-5.5", ...CHECKED_IN_MODELS.flatMap(route => [route.behaviorTemplate, ...(route.compatibilityModels || [])])].filter(Boolean))];
  const native = { models: slugs.map(slug => ({ ...structuredClone(base), slug })) };
  const nativePath = path.join(directory, "native-models.json");
  const catalogPath = path.join(directory, "merged-models.json");
  const cli = path.join(directory, "fixture.mjs"), binary = path.join(directory, "fixture.cmd");
  const callsPath = path.join(directory, "calls.jsonl");
  const sourceHome = path.join(directory, "source-home");
  writeFileSync(cli, `import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2), mode=process.env.CATALOG_TEST_MODE;
appendFileSync(process.env.CATALOG_TEST_CALLS,JSON.stringify({args,home:process.env.CODEX_HOME})+'\\n');
if(args[0]==='--version')console.log(${JSON.stringify(version)});
else if(args[0]==='debug')process.stdout.write(readFileSync(process.env.CATALOG_TEST_NATIVE,'utf8'));
else if(args[0]==='--config') {
 if(mode==='stderr-failure') {console.error(${JSON.stringify(canary)});process.exit(11);}
 if(mode==='stdout-failure') {console.log(${JSON.stringify(canary)});process.exit(17);}
 if(mode==='invalid-json') {console.log(${JSON.stringify(canary)});process.exit(0);}
 const data=JSON.parse(readFileSync(JSON.parse(args[1].slice('model_catalog_json='.length)),'utf8'));
 if(mode==='missing-route')data.models=data.models.filter(m=>m.slug!=='switchyard/auto');
 if(mode==='advertised-route')data.models.push({slug:'switchyard/auto'});
 if(mode==='changed-compaction')data.models.find(m=>m.slug==='switchyard/auto').auto_compact_token_limit=17;
 process.stdout.write(JSON.stringify(data));
} else process.exit(19);
`);
  writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const routes = clampModelEfforts(applyMultiAgentCapabilities(CHECKED_IN_MODELS, { version: 2, mode: "proven", enabled: [], disabled: [] }, { hidden: new Set() }), codexEffortVocabulary(version));
  const candidate = data => ({ models: applyPickerVisibility(buildMergedCatalog(data, routes), {
    nativeBaseSlugs: new Set(data.models.map(model => model.slug)), hiddenModels: new Set(), visibleModels: new Set(), hasExplicitVisibility: false,
  }) });
  const invoke = (data, mode = "normal", installed = false, current = false, transformCatalog = value => value) => {
    writeFileSync(nativePath, JSON.stringify(data));
    writeFileSync(catalogPath, JSON.stringify(transformCatalog(candidate(data))));
    writeFileSync(callsPath, "");
    const result = spawnSync(process.execPath, [path.join(root, "scripts/check-codex-catalog-compat.mjs"), current ? "--current" : binary,
      ...(installed ? ["--catalog", catalogPath] : [])], {
      encoding: "utf8", windowsHide: true, timeout: 15000,
      env: { ...process.env, CODEX_HOME: sourceHome, CODEX_ROUTER_STATE_DIR: path.join(sourceHome, "codex-router"),
        MODEL_ROUTER_STATE_DIR: path.join(sourceHome, "codex-router"),
        MODEL_ROUTER_MULTI_AGENT_STATE: path.join(sourceHome, "multi-agent-settings.json"),
        MODEL_ROUTER_MODEL_PICKER_STATE: path.join(sourceHome, "model-picker.json"), CODEX_BIN: binary,
        CATALOG_TEST_MODE: mode, CATALOG_TEST_NATIVE: nativePath, CATALOG_TEST_CALLS: callsPath },
    });
    assert.equal(result.error, undefined, result.error?.message);
    const calls = readFileSync(callsPath, "utf8").trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    for (const call of calls.filter(call => call.args[0] === "--config")) {
      assert.notEqual(call.home, sourceHome);
      assert.equal(existsSync(call.home), false, "parse home is retired after success or rejection");
    }
    return { ...result, calls };
  };
  for (const [installed, current] of [[false, false], [false, true], [true, false]]) {
    const result = invoke(native, "normal", installed, current);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /compatibility passed/u);
    assert.equal(result.calls.length, installed ? 2 : 3);
  }
  const large = structuredClone(native);
  large.models.find(model => model.slug === "gpt-5.5").future_metadata = "x".repeat(1100000);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(candidate(large))) < 32 * 1024 * 1024);
  for (const installed of [false, true]) {
    const result = invoke(large, "normal", installed);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /compatibility passed/u);
  }
  const incompatible = structuredClone(native);
  incompatible.models.find(model => model.slug === "gpt-6-astra").tool_mode = "code_mode";
  const omitted = invoke(incompatible, "normal", true);
  assert.equal(omitted.status, 0, omitted.stderr);
  assert.match(omitted.stdout, /Switchyard safely omitted/u);
  assert.doesNotMatch(omitted.stdout, /Switchyard compatibility passed/u);
  assert.match(omitted.stderr, /routed_model_omitted.*requires compatible tool_mode/u);
  assert.equal(omitted.calls.some(call => call.args[0] === "--config"), true,
    "an expected omission still parses the complete installed catalog with Codex");
  for (const current of [false, true]) {
    const strict = invoke(incompatible, "normal", false, current);
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /cannot publish Switchyard.*requires compatible tool_mode/u);
    assert.equal(strict.calls.some(call => call.args[0] === "--config"), false);
  }
  const advertised = invoke(incompatible, "normal", true, false, catalog => ({
    models: [...catalog.models, candidate(native).models.find(model => model.slug === "switchyard/auto")],
  }));
  assert.notEqual(advertised.status, 0);
  assert.match(advertised.stderr, /installed catalog advertises incompatible routed entry switchyard\/auto/u);
  assert.equal(advertised.calls.some(call => call.args[0] === "--config"), false);
  const parsedAdvertisement = invoke(incompatible, "advertised-route", true);
  assert.notEqual(parsedAdvertisement.status, 0);
  assert.match(parsedAdvertisement.stderr, /parsed catalog advertises incompatible routed entry switchyard\/auto/u);
  const missingExternal = invoke(incompatible, "normal", true, false, catalog => ({
    models: catalog.models.filter(model => model.slug !== "openrouter/pareto"),
  }));
  assert.notEqual(missingExternal.status, 0);
  assert.match(missingExternal.stderr, /catalog is missing routed entry openrouter\/pareto/u);
  const unexpectedlyMissing = invoke(native, "normal", true, false, catalog => ({
    models: catalog.models.filter(model => model.slug !== "switchyard/auto"),
  }));
  assert.notEqual(unexpectedlyMissing.status, 0);
  assert.match(unexpectedlyMissing.stderr, /catalog is missing routed entry switchyard\/auto/u);
  for (const [mode, message] of [
    ["stderr-failure", /exit status 11/u], ["stdout-failure", /exit status 17/u],
    ["invalid-json", /invalid JSON/u], ["missing-route", /did not parse routed catalog entry/u],
    ["changed-compaction", /did not preserve Switchyard native compaction/u],
  ]) {
    const result = invoke(native, mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-capture-canary/u);
  }
  const unsupported = structuredClone(native);
  unsupported.models.find(model => model.slug === CHECKED_IN_MODELS.find(route => route.slug === "switchyard/auto").upstreamModel).supported_reasoning_levels = [];
  const result = invoke(unsupported);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support/u);
  assert.equal(result.calls.some(call => call.args[0] === "--config"), false);
});
