import assert from "node:assert/strict";
import test from "node:test";

import { summarizeSwitchyardCertificationEvidence } from "../src/switchyard-certification-evidence.mjs";

test("certification evidence keeps useful route facts and removes identifiers", () => {
  const summary = summarizeSwitchyardCertificationEvidence({
    routerLog: [
      "Switchyard libsy server",
      "2026-09-04T05:10:06Z INFO selected_model=\"switchyard/sol-medium\" agent_id=\"secret-agent\" correlation_id=\"secret-correlation\"",
      "[codex-router] timing at=2026-09-04T05:10:07Z model=switchyard/auto provider=switchyard status=200 total_ms=800 out_tokens=14 cached_tokens=120",
      "[codex-router] timing at=2026-09-04T05:10:08Z model=switchyard/auto provider=switchyard status=499 total_ms=900",
    ].join("\n"),
    routingLog: [
      JSON.stringify({ ts: "2026-09-04T05:09:00Z", session_id: "old-session", model: "switchyard/luna-high" }),
      JSON.stringify({ ts: "2026-09-04T05:10:07Z", session_id: "secret-session", model: "switchyard/sol-medium", prompt_tokens: 100, cached_tokens: 80, completion_tokens: 14 }),
    ].join("\n"),
  });

  assert.equal(summary.router.total, 2);
  assert.equal(summary.router.successful, 1);
  assert.deepEqual(summary.router.statuses, { 200: 1, 499: 1 });
  assert.equal(summary.routing.total, 1);
  assert.equal(summary.routing.uniqueSessions, 1);
  assert.equal(summary.routing.recent[0].model, "switchyard/sol-medium");
  assert.doesNotMatch(JSON.stringify(summary), /secret-agent|secret-correlation|secret-session|old-session/u);
});

test("certification evidence is bounded and fails closed without a generation", () => {
  assert.deepEqual(summarizeSwitchyardCertificationEvidence({ routerLog: "status=200" }), {
    version: 1,
    generationFound: false,
  });
  assert.throws(
    () => summarizeSwitchyardCertificationEvidence({ routerLog: "", limit: 101 }),
    /integer from 1 to 100/u,
  );
});
