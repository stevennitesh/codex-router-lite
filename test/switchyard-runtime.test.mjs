import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  parseSwitchyardConfigContract,
  validateSwitchyardConfigContract,
} from "../scripts/switchyard-config-contract.mjs";
import { validateV2AgentApplications } from "../scripts/check-v2-agent-applications.mjs";
import { PROVIDERS, resolveProviderBaseUrl } from "../src/routed-models.mjs";
import { switchyardProofFixture } from "./switchyard-proof-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Switchyard validates effective target values through materialization, ignoring inert examples", t => {
  const template = readFileSync(path.join(root, "config/switchyard/routes.template.toml"), "utf8");
  const model = readSwitchyardConfigContract(root).routeModel;
  const fixture = mkdtempSync(path.join(tmpdir(), "switchyard-effective-contract-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const directory of ["src", "scripts", "config/switchyard"]) mkdirSync(path.join(fixture, directory), { recursive: true });
  for (const file of ["src/toml-structure.mjs", "scripts/switchyard-config-contract.mjs", "scripts/materialize-switchyard-routes.mjs", "config/switchyard/auto.json"]) {
    copyFileSync(path.join(root, file), path.join(fixture, file));
  }
  const candidates = '["luna_max", "sol_high", "astra_medium", "astra_xhigh"]';
  const variants = [
    [true, template],
    [true, template.replace('[targets.sol_high]', '["targets"."sol_high"]')
      .replace('body_overrides = { store = false, stream = true, reasoning = { effort = "high" } }',
        '"body_overrides" = { store = false, stream = true, "reasoning" = { "ef\\u0066ort" = \'high\' } }')
      .replace(`candidates = ${candidates}`, 'candidates = [\n"luna_max", # active array comment\n"sol_high", "astra_medium", "astra_xhigh",\n]')],
    [false, template.replace('id = "gpt-6.1-sol"', 'description = """\nid = "gpt-6.1-sol"\n"""\nid = "gpt-6-astra"')],
    [false, template.replace('body_overrides = { store = false, stream = true, reasoning = { effort = "high" } }',
      '# body_overrides = { reasoning = { effort = "high" } }\nbody_overrides = { store = false, stream = true, reasoning = { effort = "low" } }')],
    [false, template.replace(`candidates = ${candidates}`, `description = '''\ncandidates = ${candidates}\n'''\ncandidates = ["sol_high"]`)],
    [false, template.replace('reasoning = { effort = "high" }', 'reasoning = { effort = "high", effort = "low" }')],
    [false, template.replace('reasoning = { effort = "high" }', 'reasoning.effort = "high"')],
    [false, template.replace('[targets.sol_high]', '[targets.sol_high]\n[targets.sol_high]')],
    [false, template.replace('[targets.sol_high]', '[[targets.sol_high]]')],
    [false, template.replace(`candidates = ${candidates}`, 'candidates = ["luna_max", "sol_high", "astra_medium", "astra_medium"]')],
  ];
  for (const [accepted, source] of variants) {
    const validate = () => validateSwitchyardConfigContract(parseSwitchyardConfigContract(source, model));
    if (accepted) assert.doesNotThrow(validate);
    else assert.throws(validate);
    writeFileSync(path.join(fixture, "config/switchyard/routes.template.toml"), source);
    const output = path.join(fixture, "routes.toml");
    rmSync(output, { force: true });
    const result = spawnSync(process.execPath, [path.join(fixture, "scripts/materialize-switchyard-routes.mjs"),
      output, "http://127.0.0.1:4202/v1"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status === 0, accepted, result.stderr);
    assert.equal(existsSync(output), accepted, "rejected effective policy cannot publish routes");
    if (accepted) assert.equal(readFileSync(output, "utf8"), source.replace(/\r\n/gu, "\n")
      .replace("__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__", "http://127.0.0.1:4202/v1"));
  }
});

test("Switchyard numeric contract reads whole active decimal values and refuses disguised limits", () => {
  const template = readFileSync(path.join(root, "config/switchyard/routes.template.toml"), "utf8");
  const model = readSwitchyardConfigContract(root).routeModel;
  const cases = [
    ["timeout_ms = 3000", "timeout_ms = 3000_000", value => value.classifier.timeoutMs, 3000000],
    ["max_request_bytes = 32768", "max_request_bytes = 32768_000", value => value.classifier.maxRequestBytes, 32768000],
    ["context_window = 272000", "context_window = 272000_000", value => value.contextWindow, 272000000],
  ];
  for (const [old, changed, get, expected] of cases) {
    assert.ok(template.includes(old));
    const parsed = parseSwitchyardConfigContract(template.replace(old, changed), model);
    assert.equal(get(parsed), expected);
    assert.throws(() => validateSwitchyardConfigContract(parsed));
  }
  for (const value of ["3_000", "+3000", "3000 # active comment"]) {
    assert.doesNotThrow(() => validateSwitchyardConfigContract(parseSwitchyardConfigContract(template.replace("timeout_ms = 3000", `timeout_ms = ${value}`), model)));
  }
  for (const value of ["3000junk", "3000__000", "3000.0", "3e3", "0xbb8", '"3000"', "3_000_", "3000\ntimeout_ms = 3000"]) {
    assert.throws(() => parseSwitchyardConfigContract(template.replace("timeout_ms = 3000", `timeout_ms = ${value}`), model));
  }
  assert.doesNotThrow(() => validateSwitchyardConfigContract(parseSwitchyardConfigContract(
    template.replace("base_threshold = 0.35", "base_threshold = 3.5e-1"), model)));
  for (const ignored of ['# timeout_ms = 9999', 'description = """\ntimeout_ms = 9999\n"""']) {
    const source = template.replace("[type_safe_client]", `[type_safe_client]\n${ignored}`);
    assert.equal(parseSwitchyardConfigContract(source, model).classifier.timeoutMs, 3000);
  }
});

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
  assert.match(
    source,
    /const credential = resolveProviderCredential\("openrouter"\)[\s\S]*OPENROUTER_API_KEY: credential\.value/u,
  );
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
  const proof = switchyardProofFixture();
  const applicationsRoot = mkdtempSync(path.join(tmpdir(), "switchyard-proof-"));
  const proofRoot = path.join(applicationsRoot, "switchyard", "auto");
  mkdirSync(proofRoot, { recursive: true });
  writeFileSync(path.join(proofRoot, "proof.md"), "# Synthetic proof\n\n## Evidence\n");
  const models = [{
    slug: "switchyard/auto",
    provider: "switchyard",
    upstreamModel: "gpt-6.1-sol",
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

test("Switchyard routing corpus retains its frozen quality and fidelity gates", () => {
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
  assert.equal(corpus.fidelity.length, 11);
  assert.doesNotMatch(evaluator, /fetch\("https:\/\/openrouter\.ai/u);
});
