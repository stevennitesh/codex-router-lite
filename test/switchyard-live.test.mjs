import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openPort } from "./port-pool.mjs";
import { observationIdentity } from "../src/request-observation.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

for (const scenario of ["stable", "drift", "foreign-only", "missing-media", "compact-classifier",
    "known-build", "provider-canary", "unknown-provider", "unversioned-provider", "empty-build-provider",
    "override", "override-poisoned-default", "override-foreign-only", "override-missing", "state-fallback", "binary-override", "config-override", "independent-overrides",
    "binary-missing", "binary-invalid", "config-missing", "config-invalid", "provenance-missing", "provenance-unreadable",
    "provenance-malformed", "binding-invalid", "template-mismatch", "provenance-drift", "fresh-logs",
    "router-missing", "routing-missing", "router-unreadable", "routing-unreadable", "router-empty", "routing-empty", "router-stale", "routing-stale"]) {
  test(`Switchyard smoke: ${scenario}`, async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "switchyard-smoke-"));
    const state = path.join(fixture, "router-state");
    const foreignOnly = scenario === "foreign-only" || scenario === "override-foreign-only";
    const defaultRuntime = path.join(fixture, "switchyard");
    const useOverride = scenario.startsWith("override") || scenario === "fresh-logs";
    const runtime = useOverride ? path.join(fixture, "alternate-runtime") : defaultRuntime;
    const log = path.join(state, "router.log"), routing = path.join(runtime, "routing.jsonl");
    const provenance = path.join(runtime, "provenance.json");
    const binding = {
      routerCommit: "a".repeat(40), upstreamCommit: "b".repeat(40), binarySha256: "a".repeat(64), routesSha256: "b".repeat(64),
      templateSha256: createHash("sha256").update(readFileSync(path.join(root, "config/switchyard/routes.template.toml"))).digest("hex"),
    };
    const writeRuntime = (target, record = binding) => {
      mkdirSync(target);
      writeFileSync(path.join(target, "switchyard-server.exe"), "synthetic executable");
      writeFileSync(path.join(target, "routes.toml"), "synthetic config");
      writeFileSync(path.join(target, "provenance.json"), JSON.stringify({ ...record, privateCanary: "PRIVATE_ACCOUNT_CANARY" }));
    };
    mkdirSync(state);
    writeRuntime(runtime);
    if (["override-poisoned-default", "override-foreign-only", "override-missing", "fresh-logs"].includes(scenario)) {
      writeRuntime(defaultRuntime, { ...binding, routerCommit: "c".repeat(40) });
      writeFileSync(path.join(defaultRuntime, "routing.jsonl"), JSON.stringify({
        ts: "2000-01-01T00:00:00.000Z", session_id: randomUUID(), model: "switchyard/astra-xhigh",
      }) + "\n");
    }
    if (scenario === "override-missing") rmSync(runtime, { recursive: true });
    const finalLogFailure = /^(?:router|routing)-(?:missing|unreadable|empty|stale)$/u.test(scenario);
    const freshLogs = scenario === "fresh-logs" || finalLogFailure;
    if (!freshLogs) {
      writeFileSync(log, "Switchyard libsy server\n");
      if (scenario !== "override-missing") writeFileSync(routing, "");
    }
    writeFileSync(path.join(state, "caller-secret"), "synthetic".repeat(8));
    writeFileSync(path.join(fixture, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic", account_id: "fixture" } }));
    const env = { ...process.env, CODEX_HOME: fixture, MODEL_ROUTER_STATE_DIR: state,
      MODEL_ROUTER_CODEX_AUTH: path.join(fixture, "auth.json") };
    for (const name of ["CODEX_ROUTER_SWITCHYARD_ROOT", "CODEX_ROUTER_SWITCHYARD_BIN", "CODEX_ROUTER_SWITCHYARD_CONFIG"]) delete env[name];
    if (useOverride) env.CODEX_ROUTER_SWITCHYARD_ROOT = runtime;
    if (scenario === "state-fallback") delete env.CODEX_HOME;
    for (const [kind, file, variable] of [
      ["binary", "switchyard-server.exe", "CODEX_ROUTER_SWITCHYARD_BIN"], ["config", "routes.toml", "CODEX_ROUTER_SWITCHYARD_CONFIG"],
    ]) {
      if (scenario === `${kind}-override` || scenario === "independent-overrides") {
        env[variable] = path.join(fixture, `override-${file}`);
        writeFileSync(env[variable], "synthetic independent artifact");
        rmSync(path.join(runtime, file));
      }
      if ([`${kind}-missing`, `${kind}-invalid`].includes(scenario)) {
        rmSync(path.join(runtime, file));
        if (scenario === `${kind}-invalid`) mkdirSync(path.join(runtime, file));
      }
    }
    if (scenario === "provenance-missing") rmSync(provenance);
    if (scenario === "provenance-malformed") writeFileSync(provenance, "{malformed");
    if (scenario === "binding-invalid") writeFileSync(provenance, JSON.stringify({ ...binding, routerCommit: "PRIVATE_ACCOUNT_CANARY" }));
    if (scenario === "template-mismatch") writeFileSync(provenance, JSON.stringify({ ...binding, templateSha256: "c".repeat(64) }));
    // Share a clock for synthetic logs and verifier phase bounds: separate
    // Windows processes can disagree by a millisecond at this boundary.
    const fixtureNow = Date.now();
    const clockPath = path.join(fixture, "clock.mjs");
    const denied = scenario === "provenance-unreadable" ? provenance
      : scenario.endsWith("-unreadable") ? scenario.startsWith("router-") ? log : routing : null;
    const finished = path.join(fixture, "requests-finished");
    // Inject only the child fixture's filesystem failure; no real ACL or
    // installed state changes are needed to exercise strict read handling.
    writeFileSync(clockPath, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
globalThis.Date = class extends Date {
  constructor(...args) { super(...(args.length ? args : [${fixtureNow}])); }
  static now() { return ${fixtureNow}; }
};
${denied ? `const read = fs.readFileSync;
fs.readFileSync = function(target, ...args) {
  if (String(target) === ${JSON.stringify(denied)} && (${scenario === "provenance-unreadable"} || fs.existsSync(${JSON.stringify(finished)}))) {
    throw Object.assign(new Error("synthetic read denied"), { code: "EACCES" });
  }
  return read.call(this, target, ...args);
};
syncBuiltinESMExports();` : ""}
`);
    const requests = [];
    let firstPostLogs;
    let tools = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/health") { response.end("{}"); return; }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const id = request.headers["session-id"];
      firstPostLogs ||= { router: existsSync(log), routing: existsSync(routing) };
      requests.push({ body, id, thread: request.headers["thread-id"] });
      const compact = body.input.at(-1)?.type === "compaction_trigger";
      const media = body.input[0]?.content?.some?.(part => part.type === "input_image");
      const isTool = !media && !compact;
      if (isTool) tools += 1;
      if (body.model === "switchyard/auto") {
        const at = new Date(fixtureNow).toISOString();
        const foreign = randomUUID();
        const observe = (session, target, evidence) => {
          mkdirSync(runtime, { recursive: true });
          if (!existsSync(log)) writeFileSync(log, "Switchyard libsy server\n");
          appendFileSync(log, `[codex-router] timing at=${at} model=switchyard/auto provider=switchyard status=200 session_sha256=${observationIdentity("session", session)} thread_sha256=${observationIdentity("thread", session)}\n`);
          if (target) appendFileSync(routing, JSON.stringify({ ts: at, session_id: session, model: target }) + "\n");
          if (evidence) appendFileSync(log, `${at} INFO libsy.run: ${evidence} session_id="${session}" agent_id="${session}"\n`);
        };
        const provider = ({"known-build":"typesafe/jev-1.13-20260917","provider-canary":"typesafe/jev-1.13-PRIVATE_ACCOUNT_CANARY",
          "unknown-provider":"typesafe/jev-latest-PRIVATE_ACCOUNT_CANARY","unversioned-provider":"typesafe/jev-1.13",
          "empty-build-provider":"typesafe/jev-1.13-"})[scenario] || "typesafe/jev-1.13-fixture";
        const classifier = `evidence_source="type_safe_classifier" evidence_provider_model="${provider}" evidence_final_target="sol_high" evidence_probability_luna_max=0.1 evidence_probability_sol_high=0.7 evidence_probability_astra_medium=0.1 evidence_probability_astra_xhigh=0.1`;
        // Foreign traffic is deliberately earlier than this request's evidence.
        observe(foreign, "switchyard/luna-max", classifier);
        const missing = foreignOnly || (scenario === "missing-media" && media);
        if (!missing) observe(id, compact ? null : scenario === "drift" && tools === 2 && isTool ? "switchyard/astra-xhigh" : "switchyard/sol-high",
          compact ? scenario === "compact-classifier" ? classifier : null : media
            ? 'evidence_source="fail_open" evidence_final_target="sol_high" evidence_reason_code="non_text_state"'
            : tools === 1 ? classifier : null);
      }
      if (requests.length === 5) {
        if (scenario === "provenance-drift") writeFileSync(provenance, JSON.stringify({ ...binding, routesSha256: "c".repeat(64) }));
        if (finalLogFailure) {
          const target = scenario.startsWith("router-") ? log : routing;
          if (scenario.endsWith("-missing")) rmSync(target);
          if (scenario.endsWith("-empty")) writeFileSync(target, "");
          if (scenario.endsWith("-stale")) {
            writeFileSync(target, readFileSync(target, "utf8").replaceAll(new Date(fixtureNow).toISOString(), "2000-01-01T00:00:00.000Z"));
          }
        }
        writeFileSync(finished, "finished");
      }
      const output = isTool && tools === 1
        ? [{ type: "function_call", name: "synthetic_lookup", call_id: "fixture", arguments: '{"key":"fixture"}' }]
        : [{ type: "message", content: [{ type: "output_text", text: media ? "red" : "SYNTHETIC_VALUE_42" }] }];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ model: body.model, status: "completed", output }));
    });
    const port = await openPort();
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    env.MODEL_ROUTER_PORT = String(port);
    const outputPath = path.join(fixture, "evidence.json");
    try {
      let code = 0, stdout = "", stderr = "";
      try {
        ({ stdout, stderr } = await run(process.execPath, ["--import", pathToFileURL(clockPath).href, "scripts/verify-switchyard-live.mjs", outputPath], {
          cwd: root, windowsHide: true, timeout: 20_000,
          env,
        }));
      } catch (error) {
        code = error.code; stdout = error.stdout; stderr = error.stderr;
        assert.equal(typeof code, "number", stderr);
        assert.notEqual(code, 0, stderr);
      }
      assert.doesNotMatch(stdout, /PRIVATE_ACCOUNT_CANARY/u);
      const preflightFailure = /^(?:binary|config)-(?:missing|invalid)$/u.test(scenario) ||
        scenario.startsWith("provenance-") && scenario !== "provenance-drift" ||
        ["override-missing", "binding-invalid", "template-mismatch"].includes(scenario);
      if (preflightFailure) {
        assert.notEqual(code, 0);
        assert.equal(existsSync(outputPath), false);
        assert.equal(requests.length, 0);
        assert.doesNotMatch(stderr, /PRIVATE_ACCOUNT_CANARY/u);
        return;
      }
      assert.equal(requests.length, 5);
      if (freshLogs) assert.deepEqual(firstPostLogs, { router: false, routing: false });
      if (finalLogFailure && /-(?:missing|unreadable)$/u.test(scenario)) {
        assert.notEqual(code, 0);
        assert.match(stderr, scenario.endsWith("-missing") ? /ENOENT/u : /EACCES/u);
        assert.equal(existsSync(outputPath), false);
        return;
      }
      const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
      if (scenario === "provenance-drift") {
        assert.equal(code, 1);
        assert.ok(evidence.requiredFailures.includes("runtime provenance changed during smoke"));
        return;
      }
      if (finalLogFailure) {
        assert.equal(code, 1);
        assert.ok(evidence.requiredFailures.length > 0);
        return;
      }
      const failure = foreignOnly || ["drift", "missing-media", "compact-classifier", "unknown-provider", "unversioned-provider", "empty-build-provider"].includes(scenario);
      assert.equal(code, failure ? 1 : 0, JSON.stringify({ scenario, requiredFailures: evidence.requiredFailures }));
      assert.deepEqual(evidence.binding, binding);
      if (!failure) assert.deepEqual(evidence.requiredFailures, []);
      assert.equal(evidence.ordinaryToolRoundTrip.affinityStable, !foreignOnly && scenario !== "drift");
      assert.equal(evidence.mediaFallback.fallbackObserved, !foreignOnly && scenario !== "missing-media");
      assert.equal(evidence.nativeCompaction.bypassedClassifier, !foreignOnly && scenario !== "compact-classifier");
      assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE_ACCOUNT_CANARY/u);
      if (["unknown-provider","unversioned-provider","empty-build-provider"].includes(scenario)) {
        assert.equal(evidence.classifier.pinnedClassifierBuildObserved,false);
        assert.deepEqual(evidence.requiredFailures,["classifier binding evidence is incomplete"]);
      }
      if (["stable","known-build","provider-canary"].includes(scenario)) {
        assert.equal(evidence.classifier.pinnedClassifierBuildObserved,true);
        assert.deepEqual(evidence.classifier.providerVersions,[scenario === "known-build" ? "typesafe/jev-1.13-20260917" : "jev-1.13 build"]);
      }
      const own = requests.filter(item => item.body.model === "switchyard/auto");
      assert.equal(own.length, 4);
      assert.equal(own[0].id, own[1].id);
      assert.equal(new Set(own.map(item => item.id)).size, 3);
      for (const item of own) {
        assert.equal(item.id, item.thread);
        assert.ok(!JSON.stringify(evidence).includes(item.id));
        assert.ok(!JSON.stringify(evidence).includes(observationIdentity("session", item.id)));
      }
      const control = requests.find(item => item.body.model !== "switchyard/auto");
      assert.equal(control.body.model, "gpt-6.1-sol");
      assert.deepEqual(control.body.reasoning, { effort: "high" });
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
