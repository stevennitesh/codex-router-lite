import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  assert.match(autoRoute, /policy_hash\s*=\s*"5fd25e076c6997fe4e997ba313206766e896bcf082ac83e29e57ba54f989748f"/u);
  assert.match(autoRoute, /classify_trigger\s*=\s*"user_turn"/u);
  assert.doesNotMatch(template, /\[targets\.luna_high\]/u);
  assert.doesNotMatch(template, /type\s*=\s*"llm_classifier"/u);
  assert.match(template, /base_url\s*=\s*"https:\/\/openrouter\.ai\/api\/alpha\/decisions"/u);
  assert.match(template, /model\s*=\s*"typesafe\/jev-1\.13"/u);
});

test("Switchyard answer targets match the checked catalog compatibility families", () => {
  const contract = readSwitchyardConfigContract(root);
  assert.equal(validateSwitchyardConfigContract(contract), contract);
  assert.equal(contract.dispatchId, contract.routeModel.gatewayModel);
  assert.equal(contract.answers.length, 4);
});

test("Switchyard evaluation binds the selected binary and ordered source chain", () => {
  const source = readFileSync(path.join(root, "scripts", "evaluate-switchyard-a2.mjs"), "utf8");
  assert.match(source, /--candidate-binary/u);
  assert.match(source, /--candidate-config/u);
  assert.match(source, /--installed-baseline/u);
  assert.match(source, /lock\.upstreamContribution\.patchSha256/u);
  assert.match(source, /role: "reviewed-upstream-contribution"/u);
  assert.match(source, /role: "router-compatibility"/u);
  assert.doesNotMatch(source, /a70a1fba2f975b6eb0f1066a2cd2a82bfc7d3052/u);
  assert.doesNotMatch(source, /72c3e4b77be8a60ae9af00ca80dab1a323d92167a337a8658c484790030795ea/u);
});

test("B2 calibration uses the candidate runtime and a self-verifying frozen policy", () => {
  const evaluator = readFileSync(path.join(root, "scripts", "evaluate-switchyard-b2.mjs"), "utf8");
  const materializer = readFileSync(path.join(root, "scripts", "materialize-switchyard-routes.mjs"), "utf8");
  const evidence = JSON.parse(readFileSync(
    path.join(root, "docs", "history", "2026-09-18-switchyard-b2-evidence.json"),
    "utf8",
  ));
  const { sha256, ...policy } = evidence.policy;

  assert.match(evaluator, /fetch\(`\$\{base\}\/v1\/decision`/u);
  assert.doesNotMatch(evaluator, /fetch\(endpoint/u);
  assert.match(evaluator, /freshHoldoutCorpusSha256/u);
  assert.match(evaluator, /request start through parsed response body/u);
  assert.match(evaluator, /if \(!evidence\.promotionEligible \|\| evidence\.failures\.length\) process\.exitCode = 1/u);
  assert.match(evaluator, /known_critical_training_underroute/u);
  assert.match(evaluator, /evidence\.holdoutGatePassed && evidence\.promotionBlockers\.length === 0/u);
  assert.match(materializer, /computedPolicyHash !== recordedPolicyHash/u);
  assert.match(materializer, /configuredRoute !== route/u);
  assert.equal(createHash("sha256").update(JSON.stringify(policy)).digest("hex"), sha256);
  assert.equal(policy.threshold, evidence.selectedThreshold);
  assert.equal(evidence.results.length, evidence.corpus.total);
  assert.equal(evidence.holdoutGatePassed, true);
  assert.equal(evidence.promotionEligible, true);
  assert.deepEqual(evidence.promotionBlockers, []);
  const x03 = JSON.parse(readFileSync(
    path.join(root, "docs", "history", "2026-09-18-switchyard-b2-r3-x03-counterfactual.json"),
    "utf8",
  ));
  assert.equal(x03.status, "semantically_reviewed_pending_lead_decision");
  assert.equal(x03.results.length, 2);
  assert.equal(x03.results.flatMap((result) => result.legs).every((leg) => leg.semanticReview.allPassed), true);
});
