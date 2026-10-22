import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const fixtureParent = path.join(root, ".tmp");
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(path.join(fixtureParent, "switchyard-evaluator-"));
const syntheticEnvironment = {
  CODEX_HOME: path.join(fixtureRoot, "codex"),
  MODEL_ROUTER_STATE_DIR: path.join(fixtureRoot, "state"),
  CODEX_ROUTER_STATE_DIR: path.join(fixtureRoot, "state"),
  MODEL_ROUTER_MODEL_PICKER_STATE: path.join(fixtureRoot, "model-picker.json"),
  MODEL_ROUTER_MULTI_AGENT_STATE: path.join(fixtureRoot, "multi-agent-settings.json"),
};
Object.assign(process.env, syntheticEnvironment);
for (const [name, expected] of Object.entries(syntheticEnvironment)) {
  assert.equal(process.env[name], expected, `${name} must be synthetic before production ESM evaluation`);
  assert.ok(!path.relative(fixtureRoot, expected).startsWith(".."));
}
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const {
  allGatesPass,
  applyPolicy,
  assertCorpus,
  requestVector,
  routingDiagnostics,
  runtimeParity,
  stableProviderBuild,
  validateEvidence,
  verifyFidelitySourceInputs,
} = await import("../scripts/evaluate-switchyard-routing.mjs");

const item = { id: "D01", input: "Continue." };

function decisionBody(overrides = {}) {
  return {
    decision_evidence: {
      source: "type_safe_classifier",
      label: "astra_xhigh",
      final_target: "astra_xhigh",
      confidence: 0.7,
      probabilities: {
        luna_max: 0.1,
        sol_high: 0.1,
        astra_medium: 0.1,
        astra_xhigh: 0.7,
      },
      provider_model: "typesafe/jev-1.13-test",
      decision_latency_ms: 8,
      ...overrides,
    },
  };
}

test("low-confidence fail-open is a measured vector and receives no retry", async () => {
  let calls = 0;
  const body = decisionBody({
    source: "fail_open",
    reason_code: "low_confidence",
    final_target: "sol_high",
    confidence: 0.3,
    probabilities: {
      luna_max: 0.2,
      sol_high: 0.2,
      astra_medium: 0.25,
      astra_xhigh: 0.35,
    },
  });
  const result = await requestVector("http://local", "cap", item, 1, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.vector.measurementKind, "low_confidence");
  assert.equal(result.vector.rawSelected, "astra_xhigh");
  assert.equal(result.vector.runtimeFinalTarget, "sol_high");
});

test("malformed vectors fail without consuming a retry", async () => {
  let calls = 0;
  await assert.rejects(
    requestVector("http://local", "cap", item, 1, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(decisionBody({ probabilities: { sol_high: 1 } })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    /incomplete probability map/u,
  );
  assert.equal(calls, 1);
});

test("transport timeout and retryable status each use the single retry", async () => {
  for (const first of [
    () => { throw Object.assign(new Error("late"), { name: "TimeoutError" }); },
    () => new Response(null, { status: 503 }),
  ]) {
    let calls = 0;
    const result = await requestVector("http://local", "cap", item, 1, {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return first();
        return new Response(JSON.stringify(decisionBody()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.attempts.length, 2);
  }
});

test("full-body latency includes response parsing", async () => {
  const response = {
    ok: true,
    status: 200,
    async json() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return decisionBody();
    },
  };
  const result = await requestVector("http://local", "cap", item, 0, {
    fetchImpl: async () => response,
  });
  assert.ok(result.vector.fullBodyLatencyMs >= 20);
});

test("paid vectors use the authenticated decision endpoint and fixed request contract", async () => {
  let sent;
  await requestVector("http://local", "cap", {
    ...item,
    requestFields: {
      model: "hostile-model",
      input: "hostile-input",
      store: true,
      stream: true,
    },
  }, 0, {
    fetchImpl: async (url, options) => {
      sent = { url, method: options.method, headers: new Headers(options.headers), body: JSON.parse(options.body) };
      return new Response(JSON.stringify(decisionBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(sent.url, "http://local/v1/decision");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers.get("content-type"), "application/json");
  assert.equal(sent.headers.get("x-codex-router-switchyard-capability"), "cap");
  assert.deepEqual(sent.body, {
    input_format: "openai_responses",
    request: {
      model: "switchyard-auto",
      input: item.input,
      store: false,
      stream: false,
    },
  });
});

test("ordinary paid corpus validation does not require fidelity fixtures", () => {
  const caseBase = {
    input: "Synthetic request",
    expected: "sol_high",
    acceptable: ["sol_high"],
    severity: "normal",
  };
  const corpus = {
    schemaVersion: 1,
    privateData: false,
    labels: ["luna_max", "sol_high", "astra_medium", "astra_xhigh"],
    development: [{ ...caseBase, id: "D01" }],
    holdout: [{ ...caseBase, id: "H01" }],
    gates: { maximumRetriesPerRequest: 1, minimumAcceptablePerSplit: 1 },
  };
  assert.doesNotThrow(() => assertCorpus(corpus));
  assert.doesNotThrow(() => assertCorpus({ ...corpus, fidelity: "ignored paid-path metadata" }));
  assert.throws(
    () => assertCorpus(corpus, { requireFidelity: true }),
    /requires synthetic fidelity cases/u,
  );
});

test("expected local fallback is admitted separately from provider vectors", () => {
  const mediaItem = {
    id: "M01",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    }],
  };
  const vector = validateEvidence(mediaItem, { ok: true, status: 200 }, {
    decision_evidence: {
      source: "fail_open",
      reason_code: "non_text_state",
      final_target: "sol_high",
    },
  }, 1);
  assert.equal(vector.measurementKind, "local_fallback");
  assert.equal(vector.providerModel, null);
  assert.throws(
    () => validateEvidence(item, { ok: true, status: 200 }, {
      decision_evidence: {
        source: "fail_open",
        reason_code: "non_text_state",
        final_target: "sol_high",
      },
    }, 1),
    /unexpected local fallback/u,
  );
});

test("expected zero-call fallbacks enforce Sol High independently of quality scores and retries", async () => {
  for (const reason of ["non_text_state", "state_too_large"]) {
    const fixture = reason === "non_text_state" ? {
      id: "media", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "synthetic" }] }],
    } : { ...item, expectedLocalFallbackReasons: [reason] };
    for (const target of ["sol_high", "luna_max", "astra_medium", "astra_xhigh"]) {
      let calls = 0;
      const request = requestVector("http://local", "synthetic", fixture, 1, {
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ decision_evidence: { source: "fail_open", reason_code: reason, final_target: target } }));
        },
      });
      if (target === "sol_high") assert.equal((await request).vector.measurementKind, "local_fallback");
      else await assert.rejects(request, /local fallback must use sol_high/u);
      assert.equal(calls, 1);
      const vector = { id: fixture.id, measurementKind: "local_fallback", runtimeFinalTarget: target };
      assert.equal(applyPolicy(vector, 0.35), "sol_high");
      assert.equal(runtimeParity([fixture], [vector], 0.35).passed, target === "sol_high");
    }
  }
});

test("media fallback follows the latest genuine explicit user task without changing input", async () => {
  const message = content => ({ type: "message", role: "user", content });
  const media = message([{ type: "input_image", image_url: "data:image/png;base64,AA==" }]);
  const text = message([{ type: "input_text", text: "Current text task." }]);
  const blank = message([{ type: "input_text", text: "  \n\t" }]);
  const body = { decision_evidence: { source: "fail_open", reason_code: "non_text_state", final_target: "sol_high" } };
  const corpus = JSON.parse(readFileSync(path.join(root, "docs/switchyard-routing-corpus.json"), "utf8"));
  assertCorpus(corpus, { requireFidelity: true });
  const authored = corpus.fidelity.filter(sample => /^F(?:09|10|11)-/u.test(sample.id));
  assert.equal(authored.length, 3);
  for (const [input, expected] of [
    [[media], true], [[media, message([])], true], [[media, blank], true],
    [[text, media, message([]), blank], true], [[media, text, blank], false],
    [[message([]), blank], false],
    ...authored.map(sample => [sample.input, sample.expectedZeroCalls === true]),
  ]) {
    const sample = { id: "media-control", input, expected: "sol_high", acceptable: ["sol_high"], severity: "normal" };
    let sent, calls = 0;
    const request = requestVector("http://local", "synthetic", sample, 1, {
      fetchImpl: async (_url, options) => {
        calls++;
        sent = JSON.parse(options.body).request.input;
        return new Response(JSON.stringify(body));
      },
    });
    if (expected) {
      const { vector } = await request;
      assert.equal(vector.measurementKind, "local_fallback");
      const diagnostics = routingDiagnostics([sample], [vector], 0.35);
      assert.equal(diagnostics.currentPolicy.classifierMeasured, 0);
      assert.equal(diagnostics.probabilities.multiclassBrierExact, null);
    } else {
      await assert.rejects(request, /unexpected local fallback/u);
      const measured = await requestVector("http://local", "synthetic", sample, 0, {
        fetchImpl: async () => new Response(JSON.stringify(decisionBody())),
      });
      assert.equal(measured.vector.measurementKind, "classifier");
    }
    assert.equal(calls, 1);
    assert.deepEqual(sent, input);
  }
});

test("runtime parity, provider stability, and promotion gates are behavioral", () => {
  const vector = {
    id: "B1",
    measurementKind: "low_confidence",
    rawSelected: "astra_xhigh",
    confidence: 0.3,
    runtimeFinalTarget: "sol_high",
    providerModel: "typesafe/jev-1.13-test",
  };
  assert.equal(runtimeParity([{ id: "B1" }], [vector], 0.35).passed, true);
  assert.equal(runtimeParity([{ id: "B1" }], [{ ...vector, runtimeFinalTarget: "astra_medium" }], 0.35).passed, false);
  assert.deepEqual(stableProviderBuild([vector]), {
    passed: true,
    builds: ["typesafe/jev-1.13-test"],
  });
  assert.equal(stableProviderBuild([
    vector,
    { ...vector, id: "B2", providerModel: "typesafe/jev-1.13-other" },
  ]).passed, false);

  assert.equal(allGatesPass({ semantic: true, runtimeParity: false }), false);
  assert.equal(allGatesPass({ semantic: true, runtimeParity: true }), true);
});

test("routing diagnostics expose selective risk without treating confidence as calibrated", () => {
  const items = [
    { id: "A", expected: "luna_max", acceptable: ["luna_max"], severity: "normal" },
    { id: "B", expected: "astra_xhigh", acceptable: ["astra_medium", "astra_xhigh"], severity: "severe" },
    { id: "C", expected: "sol_high", acceptable: ["sol_high"], severity: "normal" },
    { id: "D", expected: "astra_medium", acceptable: ["sol_high", "astra_medium"], severity: "normal" },
  ];
  const vector = (id, rawSelected, confidence, probabilities) => ({
    id,
    measurementKind: confidence < 0.35 ? "low_confidence" : "classifier",
    rawSelected,
    confidence,
    probabilities,
    runtimeFinalTarget: confidence < 0.35 ? "sol_high" : rawSelected,
    providerModel: "typesafe/jev-1.13-test",
  });
  const vectors = [
    vector("A", "luna_max", 0.9, {
      luna_max: 0.85, sol_high: 0.05, astra_medium: 0.05, astra_xhigh: 0.05,
    }),
    vector("B", "sol_high", 0.8, {
      luna_max: 0.05, sol_high: 0.7, astra_medium: 0.15, astra_xhigh: 0.1,
    }),
    vector("C", "astra_xhigh", 0.7, {
      luna_max: 0.05, sol_high: 0.1, astra_medium: 0.15, astra_xhigh: 0.7,
    }),
    vector("D", "astra_medium", 0.3, {
      luna_max: 0.1, sol_high: 0.15, astra_medium: 0.55, astra_xhigh: 0.2,
    }),
  ];

  const diagnostics = routingDiagnostics(items, vectors, 0.35, {
    includeThresholdSweep: true,
  });

  assert.equal(diagnostics.interpretation.confidenceCalibratedProbability, false);
  assert.equal(diagnostics.interpretation.candidateOrderStability.available, false);
  assert.equal(diagnostics.currentPolicy.classifierMeasured, 4);
  assert.equal(diagnostics.currentPolicy.fallbackCount, 1);
  assert.equal(diagnostics.currentPolicy.severeUnderRoutes, 1);
  assert.equal(diagnostics.currentPolicy.expensiveOverRoutes, 1);
  assert.equal(diagnostics.rawConfusion.astra_xhigh.sol_high, 1);
  assert.equal(diagnostics.finalConfusion.astra_medium.sol_high, 1);
  assert.equal(
    diagnostics.confidenceReliability.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    4,
  );
  assert.ok(Number.isFinite(diagnostics.confidenceReliability.eceExact));
  assert.ok(Number.isFinite(diagnostics.probabilities.multiclassBrierExact));
  assert.ok(Number.isFinite(diagnostics.probabilities.meanTopTwoMargin));
  assert.ok(diagnostics.thresholdSweep.some((entry) => entry.threshold === 0.35));
  assert.ok(diagnostics.thresholdSweep.some((entry) => entry.threshold === 0.5));
});

test("offline fidelity binds both source patches and keeps its Rust fixture offline", () => {
  const lockBytes = readFileSync(path.join(root, "config", "switchyard", "source.lock"));
  const contributionBytes = readFileSync(path.join(
    root, "config", "switchyard", "patches", "switchyard-typesafe-pr-762.patch",
  ));
  const patchBytes = readFileSync(path.join(
    root, "config", "switchyard", "patches", "switchyard-codex-compat.patch",
  ));
  const lock = verifyFidelitySourceInputs(lockBytes, contributionBytes, patchBytes);
  assert.deepEqual(lock, JSON.parse(lockBytes.toString("utf8")));
  assert.throws(
    () => verifyFidelitySourceInputs(lockBytes, Buffer.concat([contributionBytes, Buffer.from("changed")]), patchBytes),
    /does not bind the upstream contribution patch/u,
  );
  assert.throws(
    () => verifyFidelitySourceInputs(lockBytes, contributionBytes, Buffer.concat([patchBytes, Buffer.from("changed")])),
    /does not bind the compatibility patch/u,
  );
  const fixture = readFileSync(path.join(
    root, "scripts", "fixtures", "switchyard-input-fidelity.rs",
  ), "utf8");
  assert.doesNotMatch(fixture, /OPENROUTER|api_key|reqwest/u);
});

// Run the unchanged module body with synthetic imports so Git, cargo, provider
// credentials and network operations cannot escape the subprocess boundary.
async function probeFidelitySnapshots() {
  const assert = (await import("node:assert/strict")).default;
  const fs = await import("node:fs");
  const path = (await import("node:path")).default;
  const vm = await import("node:vm");
  const { createHash } = await import("node:crypto");
  const [fixtureRoot, evaluatorPath] = process.argv.slice(1);
  for (const name of ["CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "MODEL_ROUTER_MODEL_PICKER_STATE", "MODEL_ROUTER_MULTI_AGENT_STATE"]) {
    const relative = path.relative(fixtureRoot, process.env[name]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), name);
  }
  const source = fs.readFileSync(evaluatorPath, "utf8");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const contributionBytes = Buffer.from("captured contribution é\r\n");
  const patchBytes = Buffer.from("captured compatibility λ\r\n");
  const fixtureBytes = Buffer.from("// synthetic offline fixture\r\n");
  const commit = "a".repeat(40);
  const sample = { input: "Synthetic", expected: "sol_high", acceptable: ["sol_high"], severity: "normal" };
  const corpus = {
    schemaVersion: 1, privateData: false, labels: ["luna_max", "sol_high", "astra_medium", "astra_xhigh"],
    development: [{ ...sample, id: "D" }], holdout: [{ ...sample, id: "H" }],
    fidelity: [{ id: "exact", input: [], expectedState: "synthetic" }, { id: "fallback", input: [], expectedZeroCalls: true, expectedReason: "empty_state" }],
    gates: { maximumRetriesPerRequest: 1, minimumAcceptablePerSplit: 1 },
  };
  const corpusBytes = Buffer.from(`${JSON.stringify(corpus, null, 2)}\r\n`);
  for (const scenario of ["changed", "change-restore", "cargo-failure", "snapshot-write-failure", "invalid-binding"]) {
    const scratch = path.join(fixtureRoot, scenario);
    const evaluator = path.join(scratch, "scripts/evaluate-switchyard-routing.mjs");
    const contribution = path.join(scratch, "config/switchyard/patches/switchyard-typesafe-pr-762.patch");
    const patch = path.join(scratch, "config/switchyard/patches/switchyard-codex-compat.patch");
    const corpusPath = path.join(scratch, "corpus.json");
    const output = path.join(scratch, "evidence.json");
    const originals = [contribution, patch, corpusPath];
    const buffers = [contributionBytes, patchBytes, corpusBytes];
    for (const target of [evaluator, contribution, path.join(scratch, "scripts/fixtures/switchyard-input-fidelity.rs"), path.join(scratch, "tmp/placeholder")]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
    fs.writeFileSync(evaluator, source);
    fs.writeFileSync(path.join(scratch, "scripts/fixtures/switchyard-input-fidelity.rs"), fixtureBytes);
    originals.forEach((target, index) => fs.writeFileSync(target, buffers[index]));
    fs.writeFileSync(path.join(scratch, "config/switchyard/source.lock"), JSON.stringify({
      commit, upstreamContribution: { sourceCommit: "b".repeat(40), patchSha256: scenario === "invalid-binding" ? "invalid" : hash(contributionBytes) }, patchSha256: hash(patchBytes),
    }));
    let tempRoot;
    const snapshotWrites = [], consumed = [], commands = [];
    const owned = target => {
      const relative = path.relative(scratch, target);
      assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `filesystem access outside fixture: ${target}`);
      return target;
    };
    const env = Object.fromEntries(Object.entries({
      CODEX_HOME: "codex", MODEL_ROUTER_STATE_DIR: "state", CODEX_ROUTER_STATE_DIR: "state",
      MODEL_ROUTER_MODEL_PICKER_STATE: "model-picker.json", MODEL_ROUTER_MULTI_AGENT_STATE: "multi-agent-settings.json",
    }).map(([name, relative]) => [name, path.join(scratch, relative)]));
    for (const target of Object.values(env)) owned(target);
    const context = vm.createContext({ Buffer, process: { argv: [], env, stdout: { write() {} } } });
    const consume = (target, index) => {
      assert.equal(path.dirname(target), tempRoot, "snapshots stay outside the cloned source");
      assert.ok(!originals.includes(target), "mutable originals are never subprocess inputs");
      const bytes = fs.readFileSync(owned(target));
      assert.deepEqual(bytes, buffers[index]);
      consumed.push({ target, sha256: hash(bytes) });
      if (scenario === "change-restore") fs.writeFileSync(originals[index], buffers[index]);
    };
    const unexpected = () => { throw new Error("unexpected credential, process or network operation"); };
    const imports = new Map([
      ["node:crypto", { createHash, randomBytes: unexpected }],
      ["node:child_process", { spawn: unexpected, spawnSync(program, args, options) {
        const command = `${program} ${args[0]}`;
        assert.ok(["git clone", "git checkout", "git rev-parse", "git apply", "cargo --version", "cargo test"].includes(command), command);
        commands.push(command);
        if (command === "git clone") {
          assert.equal(snapshotWrites.length, 3, "all captures are snapshotted before cloning");
          snapshotWrites.forEach((target, index) => assert.deepEqual(fs.readFileSync(target), buffers[index]));
          const tests = path.join(args.at(-1), "crates/switchyard-server/tests");
          fs.mkdirSync(tests, { recursive: true });
          fs.writeFileSync(path.join(tests, "server.rs"), "// synthetic server tests");
          fs.writeFileSync(contribution, "changed contribution");
          fs.writeFileSync(patch, "changed compatibility");
          fs.writeFileSync(corpusPath, JSON.stringify({ ...corpus, fidelity: [...corpus.fidelity, { id: "later-case", input: [], expectedState: "later" }] }));
        }
        if (command === "git apply") consume(args.at(-1), consumed.length);
        if (program === "cargo") assert.equal(options.env.OPENROUTER_API_KEY, "");
        if (command === "cargo test") {
          consume(options.env.SWITCHYARD_FIDELITY_CORPUS, 2);
          assert.equal(fs.readFileSync(path.join(options.cwd, "crates/switchyard-server/tests/measurement_input_fidelity.rs"), "utf8"), `// synthetic server tests\n${fixtureBytes.toString("utf8")}`);
        }
        return { status: scenario === "cargo-failure" && command === "cargo test" ? 1 : 0, stderr: "", stdout: command === "git rev-parse" ? commit : command === "cargo --version" ? "synthetic cargo" : "" };
      } }],
      ["node:fs", {
        mkdtempSync(prefix) { tempRoot = fs.mkdtempSync(owned(prefix)); return tempRoot; },
        readFileSync(target, options) { return fs.readFileSync(owned(target), options); },
        writeFileSync(target, value) {
          owned(target);
          if (tempRoot && path.dirname(target) === tempRoot) {
            snapshotWrites.push(target);
            if (scenario === "snapshot-write-failure" && snapshotWrites.length === 2) throw new Error("snapshot write refused");
          }
          return fs.writeFileSync(target, value);
        },
        rmSync(target, options) { fs.rmSync(owned(target), options); },
      }],
      ["node:net", { default: { createConnection: unexpected, createServer: unexpected } }],
      ["node:os", { default: { tmpdir: () => path.join(scratch, "tmp") } }],
      ["node:path", { default: path }],
      ["../src/provider-credentials.mjs", { resolveProviderCredential: unexpected }],
    ]);
    const module = new vm.SourceTextModule(source, { context, identifier: evaluator, initializeImportMeta(meta) { meta.dirname = path.dirname(evaluator); meta.filename = evaluator; } });
    await module.link(async specifier => {
      assert.ok(imports.has(specifier), `unexpected dependency ${specifier}`);
      const exports = imports.get(specifier);
      return new vm.SyntheticModule(Object.keys(exports), function () { for (const [name, value] of Object.entries(exports)) this.setExport(name, value); }, { context });
    });
    await module.evaluate();
    const run = () => module.namespace.runInputFidelitySource(path.join(scratch, "object-store"), corpusPath, output);
    if (scenario === "invalid-binding") {
      await assert.rejects(run, /does not bind the upstream contribution patch/u);
      assert.equal(tempRoot, undefined);
      assert.equal(fs.existsSync(output), false);
    } else {
      if (scenario.endsWith("failure")) await assert.rejects(run);
      else await run();
      const evidence = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(evidence.status, scenario.endsWith("failure") ? "input_fidelity_failed" : "input_fidelity_passed");
      const identities = [evidence.identities.upstreamContribution, evidence.identities.compatibilityPatch, evidence.identities.corpus];
      identities.forEach((identity, index) => assert.equal(identity.providedSha256, hash(buffers[index])));
      assert.equal(fs.existsSync(tempRoot), false, "temporary inputs retire after success or failure");
      snapshotWrites.forEach(target => assert.equal(fs.existsSync(target), false));
      if (scenario === "snapshot-write-failure") assert.deepEqual(commands, []);
      else {
        assert.deepEqual(commands, ["git clone", "git checkout", "git rev-parse", "git apply", "git apply", "cargo --version", "cargo test"]);
        consumed.forEach((observation, index) => assert.equal(observation.sha256, identities[index].providedSha256));
        if (!scenario.endsWith("failure")) {
          assert.deepEqual([evidence.cases, evidence.exactStateCases, evidence.zeroCallFallbackCases], [2, 1, 1]);
          originals.forEach((target, index) => assert.equal(fs.readFileSync(target).equals(buffers[index]), scenario === "change-restore"));
        }
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test("offline fidelity consumes captured bytes across edits and retires snapshots after faults", () => {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e", `(${probeFidelitySnapshots.toString()})()`,
    fixtureRoot, path.join(root, "scripts/evaluate-switchyard-routing.mjs"),
  ], { env: { ...process.env, ...syntheticEnvironment }, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}\n${result.stdout}`);
});
