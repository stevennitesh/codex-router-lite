import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { openPort } from "./port-pool.mjs";
import { observationIdentity } from "../src/request-observation.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("ordinary Switchyard smoke attributes phases despite concurrent foreign traffic and rejects missing or drifting own evidence", async () => {
  for (const scenario of ["stable", "drift", "foreign-only", "missing-media", "compact-classifier"]) {
    const fixture = mkdtempSync(path.join(tmpdir(), "switchyard-smoke-"));
    const runtime = path.join(fixture, "switchyard");
    mkdirSync(runtime);
    const log = path.join(fixture, "router.log"), routing = path.join(runtime, "routing.jsonl");
    writeFileSync(log, "Switchyard libsy server\n");
    writeFileSync(routing, "");
    writeFileSync(path.join(fixture, "caller-secret"), "synthetic".repeat(8));
    writeFileSync(path.join(fixture, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic", account_id: "fixture" } }));
    writeFileSync(path.join(runtime, "provenance.json"), JSON.stringify({
      routerCommit: "a".repeat(40), upstreamCommit: "b".repeat(40), binarySha256: "a".repeat(64), routesSha256: "b".repeat(64),
      templateSha256: createHash("sha256").update(readFileSync(path.join(root, "config/switchyard/routes.template.toml"))).digest("hex"),
    }));
    const requests = [];
    let tools = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/health") { response.end("{}"); return; }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const id = request.headers["session-id"];
      requests.push({ body, id, thread: request.headers["thread-id"] });
      const compact = body.input.at(-1)?.type === "compaction_trigger";
      const media = body.input[0]?.content?.some?.(part => part.type === "input_image");
      const isTool = !media && !compact;
      if (isTool) tools += 1;
      if (body.model === "switchyard/auto") {
        const at = new Date().toISOString();
        const foreign = randomUUID();
        const observe = (session, target, evidence) => {
          appendFileSync(log, `[codex-router] timing at=${at} model=switchyard/auto provider=switchyard status=200 session_sha256=${observationIdentity("session", session)} thread_sha256=${observationIdentity("thread", session)}\n`);
          if (target) appendFileSync(routing, JSON.stringify({ ts: at, session_id: session, model: target }) + "\n");
          if (evidence) appendFileSync(log, `${at} INFO libsy.run: ${evidence} session_id="${session}" agent_id="${session}"\n`);
        };
        const classifier = 'evidence_source="type_safe_classifier" evidence_provider_model="typesafe/jev-1.13-fixture" evidence_final_target="sol_high" evidence_probability_luna_max=0.1 evidence_probability_sol_high=0.7 evidence_probability_astra_medium=0.1 evidence_probability_astra_xhigh=0.1';
        // Foreign traffic is deliberately earlier than this request's evidence.
        observe(foreign, "switchyard/luna-max", classifier);
        const missing = scenario === "foreign-only" || (scenario === "missing-media" && media);
        if (!missing) observe(id, compact ? null : scenario === "drift" && tools === 2 && isTool ? "switchyard/astra-xhigh" : "switchyard/sol-high",
          compact ? scenario === "compact-classifier" ? classifier : null : media
            ? 'evidence_source="fail_open" evidence_final_target="sol_high" evidence_reason_code="non_text_state"'
            : tools === 1 ? classifier : null);
      }
      const output = isTool && tools === 1
        ? [{ type: "function_call", name: "synthetic_lookup", call_id: "fixture", arguments: '{"key":"fixture"}' }]
        : [{ type: "message", content: [{ type: "output_text", text: media ? "red" : "SYNTHETIC_VALUE_42" }] }];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ model: body.model, status: "completed", output }));
    });
    const port = await openPort();
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    const outputPath = path.join(fixture, "evidence.json");
    try {
      let code = 0;
      try {
        await run(process.execPath, ["scripts/verify-switchyard-live.mjs", outputPath], {
          cwd: root, windowsHide: true, timeout: 20_000,
          env: { ...process.env, CODEX_HOME: fixture, MODEL_ROUTER_STATE_DIR: fixture,
            MODEL_ROUTER_CODEX_AUTH: path.join(fixture, "auth.json"), MODEL_ROUTER_PORT: String(port) },
        });
      } catch (error) { code = error.code; assert.equal(code, 1, error.stderr); }
      const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
      assert.equal(code, scenario === "stable" ? 0 : 1, JSON.stringify(evidence.requiredFailures));
      assert.equal(evidence.ordinaryToolRoundTrip.affinityStable, ["stable", "missing-media", "compact-classifier"].includes(scenario));
      assert.equal(evidence.mediaFallback.fallbackObserved, !["foreign-only", "missing-media"].includes(scenario));
      assert.equal(evidence.nativeCompaction.bypassedClassifier, !["foreign-only", "compact-classifier"].includes(scenario));
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
  }
});
