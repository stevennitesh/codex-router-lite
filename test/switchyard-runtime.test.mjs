import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  installedSwitchyardLaunch,
  switchyardLaunch,
  switchyardHealthUrl,
  switchyardRuntimeStatus,
  switchyardSelectedForStartup,
} from "../src/switchyard-runtime.mjs";
import {
  readSwitchyardConfigContract,
  validateSwitchyardConfigContract,
} from "../scripts/switchyard-config-contract.mjs";
import { validateV2AgentApplications } from "../scripts/check-v2-agent-applications.mjs";
import { PROVIDERS, resolveProviderBaseUrl } from "../src/routed-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Switchyard supervision starts only after an explicit provider selection", () => {
  assert.equal(switchyardLaunch({ selected: false }), undefined);
  assert.equal(switchyardSelectedForStartup({ explicit: false, providers: ["switchyard"] }), false);
  assert.equal(switchyardSelectedForStartup({ explicit: true, providers: ["openrouter"] }), false);
  assert.equal(switchyardSelectedForStartup({ explicit: true, providers: ["switchyard"] }), true);
});

test("Switchyard supervision derives one loopback process and health contract", () => {
  const stateDir = path.join("C:\\fixture", "codex-router");
  const launch = switchyardLaunch({
    selected: true,
    stateDir,
    platform: "win32",
    env: {
      CODEX_HOME: "C:\\fixture",
      CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://127.0.0.1:4888/v1",
    },
    exists: () => true,
  });
  assert.equal(launch.binary, path.join("C:\\fixture", "switchyard", "switchyard-server.exe"));
  assert.equal(launch.config, path.join("C:\\fixture", "switchyard", "routes.toml"));
  assert.equal(launch.healthUrl, "http://127.0.0.1:4888/health");
  assert.deepEqual(launch.args.slice(0, 6), [
    "--config",
    launch.config,
    "--host",
    "127.0.0.1",
    "--port",
    "4888",
  ]);
  assert.equal(launch.args.at(-1), path.join("C:\\fixture", "switchyard", "routing.jsonl"));
});

test("the service injects the managed OpenRouter key only into the Switchyard child", () => {
  const source = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.match(source, /resolveProviderCredential\("openrouter"\)/u);
  assert.match(source, /OPENROUTER_API_KEY: switchyardOpenRouterCredential\.value/u);
  assert.doesNotMatch(source, /process\.env\.OPENROUTER_API_KEY\s*=/u);
});

test("Switchyard loopback validation rejects DNS lookalikes and preserves literal addresses", () => {
  const provider = PROVIDERS.get("switchyard");
  for (const host of ["127.not-loopback.invalid", "127.0.0.1.not-loopback.invalid", "192.0.2.10"]) {
    const env = { CODEX_ROUTER_SWITCHYARD_BASE_URL: `http://${host}:4000/v1` };
    const resolved = resolveProviderBaseUrl(provider, env);
    assert.equal(resolved.refusedOverride, true, host);
    assert.equal(resolved.baseUrl, provider.baseUrl);
    assert.throws(() => switchyardHealthUrl({ env }), /must bind to loopback/, host);
  }
  for (const host of ["localhost", "127.0.0.1", "127.42.3.4", "127.1", "[::1]"]) {
    const url = new URL(`http://${host}:4000/v1`);
    const env = { CODEX_ROUTER_SWITCHYARD_BASE_URL: url.href };
    assert.equal(resolveProviderBaseUrl(provider, env).refusedOverride, false, host);
    assert.equal(switchyardHealthUrl({ env }), `${url.origin}/health`, host);
  }
});

test("managed Switchyard rejects a non-loopback bind", () => {
  assert.throws(
    () => switchyardHealthUrl({
      env: { CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://192.0.2.10:4000/v1" },
    }),
    /must bind to loopback/,
  );
  assert.throws(
    () => switchyardLaunch({
      selected: true,
      stateDir: "C:\\fixture\\codex-router",
      env: {
        CODEX_HOME: "/fixture",
        CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://0.0.0.0:4000/v1",
      },
      exists: () => true,
    }),
    /must bind to loopback/,
  );
});

test("Switchyard supervision refuses a selected provider with no installed runtime", () => {
  assert.throws(
    () => switchyardLaunch({
      selected: true,
      stateDir: "C:\\fixture\\codex-router",
      env: { CODEX_HOME: "C:\\fixture" },
      exists: () => false,
    }),
    /runtime is incomplete/,
  );
});

test("Switchyard runtime status names every missing deployment artifact", () => {
  const status = switchyardRuntimeStatus({
    stateDir: "C:\\fixture\\codex-router",
    env: { CODEX_HOME: "C:\\fixture" },
    exists: () => false,
  });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, [
    path.join("C:\\fixture", "switchyard", "switchyard-server.exe"),
    path.join("C:\\fixture", "switchyard", "routes.toml"),
  ]);
});

test("installed Switchyard launch fails open when an old selection outlives its runtime", () => {
  const warnings = [];
  const launch = installedSwitchyardLaunch({
    selected: true,
    warn: (message) => warnings.push(message),
    runtimeOptions: {
      stateDir: "C:\\fixture\\codex-router",
      env: { CODEX_HOME: "C:\\fixture" },
      exists: () => false,
    },
  });
  assert.equal(launch, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /continuing without it/);
});

test("installed Switchyard launch probes each runtime artifact once", () => {
  const checked = [];
  const launch = installedSwitchyardLaunch({
    selected: true,
    runtimeOptions: {
      stateDir: "C:\\fixture\\codex-router",
      env: {
        CODEX_HOME: "C:\\fixture",
        CODEX_ROUTER_SWITCHYARD_BASE_URL: "http://127.0.0.1:4888/v1",
      },
      exists: (target) => {
        checked.push(target);
        return true;
      },
    },
  });
  assert.ok(launch);
  assert.deepEqual(checked, [
    path.join("C:\\fixture", "switchyard", "switchyard-server.exe"),
    path.join("C:\\fixture", "switchyard", "routes.toml"),
  ]);
});

test("Switchyard source lock pins the reviewed upstream contribution and compatibility patch", () => {
  const configRoot = path.join(root, "config", "switchyard");
  const lock = JSON.parse(readFileSync(path.join(configRoot, "source.lock"), "utf8"));
  const upstreamPatchBytes = readFileSync(path.join(configRoot, lock.upstreamContribution.patch));
  const patchBytes = readFileSync(path.join(configRoot, lock.patch));
  assert.match(lock.commit, /^[a-f0-9]{40}$/u);
  assert.equal(lock.upstreamContribution.kind, "github-pull-request");
  assert.equal(lock.upstreamContribution.pullRequest, 762);
  assert.match(lock.upstreamContribution.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(
    createHash("sha256").update(upstreamPatchBytes).digest("hex"),
    lock.upstreamContribution.patchSha256,
  );
  assert.equal(createHash("sha256").update(patchBytes).digest("hex"), lock.patchSha256);
  assert.match(upstreamPatchBytes.toString("utf8"), /TypeSafeTaskClassifier/);
  assert.match(patchBytes.toString("utf8"), /merge_override_value/);
  assert.match(
    patchBytes.toString("utf8"),
    /chat_text_message_maps_to_a_responses_list_with_string_content/,
  );
  const packaged = JSON.parse(readFileSync(
    path.join(root, "maintenance", "windows-package.json"),
    "utf8",
  )).files;
  assert.ok(packaged.includes(`config/switchyard/${lock.upstreamContribution.patch}`));
  assert.ok(packaged.includes(`config/switchyard/${lock.patch}`));
});

test("Switchyard accepted proof rejects changed patch and canonical template source", () => {
  const configRoot = path.join(root, "config", "switchyard");
  const lock = JSON.parse(readFileSync(path.join(configRoot, "source.lock"), "utf8"));
  const proof = JSON.parse(readFileSync(
    path.join(root, "v2_agent", "switchyard", "auto", "proof.json"),
    "utf8",
  ));
  proof.status = "accepted";
  proof.testedAt = "2026-09-20T00:00:00.000Z";
  proof.routerVersion = "fixture";
  proof.codexVersion = "fixture";
  proof.executionSurface = "codex-cli";
  proof.checks = Object.fromEntries([
    "streaming",
    "toolCall",
    "encryptedRelay",
    "markerReturn",
    "sameThreadFollowUp",
  ].map((key) => [key, {
    outcome: "pass",
    status: 200,
    observedAt: "2026-09-20T00:00:00.000Z",
  }]));
  proof.checks.toolCall.mode = "auto";
  proof.runtimeBinding.upstreamCommit = lock.commit;
  proof.runtimeBinding.upstreamContributionCommit = lock.upstreamContribution.sourceCommit;
  proof.runtimeBinding.upstreamContributionSha256 = lock.upstreamContribution.patchSha256;
  proof.runtimeBinding.patchSha256 = lock.patchSha256;
  proof.runtimeBinding.binarySha256 = "a".repeat(64);
  proof.runtimeBinding.routerCommit = "a".repeat(40);
  proof.runtimeBinding.routesSha256 = "a".repeat(64);
  proof.runtimeBinding.templateSha256 = createHash("sha256").update(readFileSync(
    path.join(configRoot, "routes.template.toml"),
  )).digest("hex");
  proof.runtimeBinding.templateSourceSha256 = createHash("sha256").update(
    readFileSync(path.join(configRoot, "routes.template.toml"), "utf8").replace(/\r\n?/gu, "\n"),
    "utf8",
  ).digest("hex");
  delete proof.runtimeBinding.policyHash;
  const applicationsRoot = mkdtempSync(path.join(tmpdir(), "switchyard-proof-"));
  const proofRoot = path.join(applicationsRoot, "switchyard", "auto");
  mkdirSync(proofRoot, { recursive: true });
  writeFileSync(path.join(proofRoot, "proof.md"), "# Synthetic proof\n\n## Evidence\n");
  const models = [{
    slug: "switchyard/auto",
    provider: "switchyard",
    upstreamModel: "gpt-5.6-sol",
    multiAgentVersion: "v2",
  }];
  try {
    writeFileSync(path.join(proofRoot, "proof.json"), JSON.stringify(proof));
    assert.equal(validateV2AgentApplications(applicationsRoot, { models }).length, 1);
    proof.runtimeBinding.patchSha256 = "0".repeat(64);
    writeFileSync(path.join(proofRoot, "proof.json"), JSON.stringify(proof));
    assert.throws(
      () => validateV2AgentApplications(applicationsRoot, { models }),
      /does not match the pinned source and patch/u,
    );
    proof.runtimeBinding.patchSha256 = lock.patchSha256;
    proof.runtimeBinding.templateSourceSha256 = "0".repeat(64);
    writeFileSync(path.join(proofRoot, "proof.json"), JSON.stringify(proof));
    assert.throws(
      () => validateV2AgentApplications(applicationsRoot, { models }),
      /does not match the pinned source and patch/u,
    );
  } finally {
    rmSync(applicationsRoot, { recursive: true, force: true });
  }
});

test("Switchyard runtime status does not misreport access denial as missing", () => {
  const status = switchyardRuntimeStatus({
    stateDir: "C:\\fixture\\codex-router",
    env: { CODEX_HOME: "C:\\fixture" },
    probe: (target) => target.endsWith(".exe")
      ? { status: "access-denied", code: "EACCES" }
      : { status: "present" },
  });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, []);
  assert.equal(status.inaccessible[0].status, "access-denied");
});

test("Switchyard's sole classifier matches the accepted bounded Jev contract", () => {
  const template = readFileSync(
    path.join(root, "config", "switchyard", "routes.template.toml"),
    "utf8",
  );
  const autoRoute = /\[routes\.auto\]([\s\S]*?)(?=\n\[)/u.exec(template)?.[1];
  assert.match(autoRoute, /type\s*=\s*"type_safe_classifier"/u);
  assert.doesNotMatch(autoRoute, /policy_hash/u);
  assert.match(autoRoute, /classify_trigger\s*=\s*"user_turn"/u);
  assert.doesNotMatch(template, /\[targets\.luna_high\]/u);
  assert.doesNotMatch(template, /type\s*=\s*"llm_classifier"/u);
  assert.match(template, /base_url\s*=\s*"https:\/\/openrouter\.ai\/api\/alpha\/decisions"/u);
  assert.match(template, /model\s*=\s*"typesafe\/jev-1\.13"/u);
  assert.match(template, /timeout_ms\s*=\s*3000/u);
});

test("Switchyard answer targets match the checked catalog compatibility families", () => {
  const contract = readSwitchyardConfigContract(root);
  assert.equal(validateSwitchyardConfigContract(contract), contract);
  assert.equal(contract.dispatchId, contract.routeModel.gatewayModel);
  assert.equal(contract.answers.length, 4);
});

test("Switchyard keeps one maintained routing evaluator over the actual decision path", () => {
  const corpus = JSON.parse(readFileSync(
    path.join(root, "docs", "switchyard-routing-corpus.json"),
    "utf8",
  ));
  const evaluator = readFileSync(
    path.join(root, "scripts", "evaluate-switchyard-routing.mjs"),
    "utf8",
  );
  assert.equal(corpus.development.length, 20);
  assert.equal(corpus.holdout.length, 20);
  assert.equal(corpus.development.filter((item) => item.boundary).length, 6);
  assert.equal(corpus.gates.maximumRetriesPerRequest, 1);
  assert.equal(corpus.gates.minimumAcceptablePerSplit, 17);
  assert.equal(corpus.gates.maximumSevereUnderRoutes, 0);
  assert.equal(corpus.fidelity.length, 8);
  assert.match(evaluator, /fetchImpl\(`\$\{base\}\/v1\/decision`/u);
  assert.match(evaluator, /request:\s*\{[\s\S]{0,160}model: "switchyard-auto",[\s\S]{0,160}input: item\.input/u);
  assert.doesNotMatch(evaluator, /fetch\("https:\/\/openrouter\.ai/u);
  assert.match(evaluator, /--input-fidelity-source/u);
  assert.match(evaluator, /verifyFidelitySourceInputs/u);
  assert.match(evaluator, /candidate_frozen_before_holdout/u);
  const materializer = readFileSync(path.join(root, "scripts", "materialize-switchyard-routes.mjs"), "utf8");
  assert.match(materializer, /validateSwitchyardConfigContract/u);
  assert.doesNotMatch(materializer, /docs.*history|evidencePath|policy_hash/isu);
  assert.doesNotMatch(evaluator, /acceptedC1|SY-B2|SY-FOLLOWUP-C2|predecessorEvidence/u);
});
