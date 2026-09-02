import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  routedAgentDefinition,
  routedCodexAgentStatus,
  syncRoutedCodexAgents,
} from "../src/codex-agent-catalog.mjs";
import { subagentEligibleModels } from "../src/multi-agent-state.mjs";

const kimi = {
  slug: "kimi-oauth/k3",
  displayName: "Kimi K3 (OAuth)",
};

const legacyOxWorker = [
  'name = "ox_worker"',
  'description = "General-purpose Ox Alpha worker for bounded codebase reading, review, implementation, and verification."',
  'model_provider = "codex-router"',
  'model = "openrouter/ox-alpha"',
  'model_reasoning_effort = "high"',
  'model_context_window = 1048576',
  'model_reasoning_summary = "none"',
  'sandbox_mode = "workspace-write"',
  'developer_instructions = """',
  "Complete only the bounded assignment from the parent and do not delegate it further.",
  "Treat read-only work as read-only. For implementation work, preserve unrelated changes and do not commit, push, publish, or modify external systems unless the assignment explicitly authorizes it.",
  "Return a concise handoff with the result, verification evidence, changed files, and any material uncertainty or blocker.",
  '"""',
  "",
].join("\n");

test("routed agent definitions select the router provider and exact model slug", () => {
  const definition = routedAgentDefinition(kimi);
  assert.equal(definition.agentName, "router_kimi_oauth_k3");
  assert.equal(definition.fileName, "router-model-kimi-oauth-k3.toml");
  assert.match(definition.contents, /^# Managed by Codex Router\./);
  assert.match(definition.contents, /model_provider = "codex-router"/);
  assert.match(definition.contents, /model = "kimi-oauth\/k3"/);
  assert.match(definition.contents, /cite the exact file and line/);
  assert.match(definition.contents, /Before claiming that something is absent/);
  assert.match(definition.contents, /Never invent or reuse a stale name/);
  assert.match(definition.contents, /Do not stop after merely announcing a next action/);
});

test("agent sync writes one private definition for every routed model", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const grok = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
  const { written, removed } = syncRoutedCodexAgents([kimi, grok], agentsDir);

  assert.deepEqual(removed, []);
  assert.deepEqual(
    written.map(({ model, agent }) => ({ model, agent })),
    [
      { model: "kimi-oauth/k3", agent: "router_kimi_oauth_k3" },
      { model: "grok-oauth/grok-4.5", agent: "router_grok_oauth_grok_4_5" },
    ],
  );
  const kimiFile = path.join(agentsDir, "router-model-kimi-oauth-k3.toml");
  assert.match(readFileSync(kimiFile, "utf8"), /name = "router_kimi_oauth_k3"/);
  assert.deepEqual(routedCodexAgentStatus([kimi, grok], agentsDir), {
    expected: 2,
    current: 2,
    missing: [],
    stale: [],
    unprotected: [],
    extra: [],
    ok: true,
  });
});

test("agent status reports definitions that have not been installed", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  assert.deepEqual(routedCodexAgentStatus([kimi], agentsDir), {
    expected: 1,
    current: 0,
    missing: ["kimi-oauth/k3"],
    stale: [],
    unprotected: [],
    extra: [],
    ok: false,
  });
});

test("agent definitions reject non-routed model slugs", () => {
  assert.throws(() => routedAgentDefinition({ slug: "gpt-5.6-sol" }), /invalid model slug/);
});

test("a model switched off as a subagent loses its definition", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const grok = { slug: "grok-oauth/grok-4.5", displayName: "Grok 4.5 (OAuth)" };
  syncRoutedCodexAgents([kimi, grok], agentsDir);

  const { written, removed } = syncRoutedCodexAgents([kimi], agentsDir);
  assert.deepEqual(
    written.map(({ model }) => model),
    ["kimi-oauth/k3"],
  );
  assert.deepEqual(removed, ["router-model-grok-oauth-grok-4-5.toml"]);
  assert.deepEqual(readdirSync(agentsDir), ["router-model-kimi-oauth-k3.toml"]);
});

test("agent sync leaves definitions it does not manage alone", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  writeFileSync(path.join(agentsDir, "reviewer.toml"), 'name = "reviewer"\n');
  syncRoutedCodexAgents([kimi], agentsDir);

  const { removed } = syncRoutedCodexAgents([], agentsDir);
  assert.deepEqual(removed, ["router-model-kimi-oauth-k3.toml"]);
  assert.deepEqual(readdirSync(agentsDir), ["reviewer.toml"]);
});

test("agent sync removes only the exact retired Ox worker definition", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  writeFileSync(path.join(agentsDir, "ox_worker.toml"), legacyOxWorker.replace(/\n/g, "\r\n"));
  assert.deepEqual(routedCodexAgentStatus([], agentsDir).extra, ["ox_worker.toml"]);

  const { removed } = syncRoutedCodexAgents([], agentsDir);
  assert.deepEqual(removed, ["ox_worker.toml"]);
  assert.deepEqual(readdirSync(agentsDir), []);
});

test("agent sync preserves a user-modified Ox-named worker", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  writeFileSync(
    path.join(agentsDir, "ox_worker.toml"),
    legacyOxWorker.replace('model = "openrouter/ox-alpha"', 'model = "user/custom"'),
  );

  const { removed } = syncRoutedCodexAgents([], agentsDir);
  assert.deepEqual(removed, []);
  assert.deepEqual(readdirSync(agentsDir), ["ox_worker.toml"]);
});

test("agent status reports a definition left behind by an older install", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  syncRoutedCodexAgents([kimi], agentsDir);

  const status = routedCodexAgentStatus([], agentsDir);
  assert.deepEqual(status.extra, ["router-model-kimi-oauth-k3.toml"]);
  assert.equal(status.ok, false);
});

test("an install with every model switched off is a clean state", () => {
  const agentsDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-agents-"));
  const status = routedCodexAgentStatus([], agentsDir);
  assert.deepEqual(status.extra, []);
  assert.equal(status.ok, true);
});

test("only registry-proven models receive routed agent definitions", () => {
  const models = [
    { slug: "kimi-oauth/k3", multiAgentVersion: "v2" },
    { slug: "grok-oauth/grok-4.5", multiAgentVersion: "v2" },
    { slug: "deepseek/deepseek-v4-flash" },
  ];
  assert.deepEqual(
    subagentEligibleModels(models, { mode: "proven", enabled: [], disabled: [] }).map(
      ({ slug }) => slug,
    ),
    ["kimi-oauth/k3", "grok-oauth/grok-4.5"],
  );
  assert.deepEqual(
    subagentEligibleModels(models, {
      mode: "all",
      enabled: [],
      disabled: ["grok-oauth/grok-4.5"],
    }).map(({ slug }) => slug),
    ["kimi-oauth/k3"],
  );
});
