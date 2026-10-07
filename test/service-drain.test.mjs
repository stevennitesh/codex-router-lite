import assert from "node:assert/strict";
import test from "node:test";

import { prepareRouterServiceMutation } from "../src/service-drain.mjs";
import { RouterAdmission } from "../src/router-admission.mjs";

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("service drain treats exact refusal as offline but fails closed on unknown transport", async () => {
  const refused = new Error("refused", { cause: Object.assign(new Error("socket"), { code: "ECONNREFUSED" }) });
  assert.deepEqual(await prepareRouterServiceMutation({ fetchImpl: async () => { throw refused; } }), {
    status: "offline",
  });
  await assert.rejects(
    prepareRouterServiceMutation({ fetchImpl: async () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); } }),
    /liveness is unknown/u,
  );
});

test("service replacement requires every complete transport branch to prove refusal", async () => {
  const refused = () => Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  const cyclic = refused(); cyclic.cause = cyclic;
  const deep = refused(); let current = deep;
  for (let index = 0; index < 10; index++) current = current.cause = refused();
  const ambiguous = [
    new AggregateError([refused(), new Error("unknown")]),
    new AggregateError([refused(), Object.assign(new Error("reset"), { code: "ECONNRESET" })]),
    new AggregateError([refused(), cyclic]),
    new Error("wrapper", { cause: { code: "ECONNREFUSED", name: "AbortError" } }),
    cyclic, deep, new AggregateError(Array.from({ length: 257 }, refused)),
  ];
  for (const error of ambiguous) {
    await assert.rejects(prepareRouterServiceMutation({
      force: true, fetchImpl: async () => { throw error; },
    }), /liveness is unknown/u);
  }
  const shared = refused();
  assert.deepEqual(await prepareRouterServiceMutation({
    fetchImpl: async () => { throw new AggregateError([shared, new Error("wrapper", { cause: shared })]); },
  }), { status: "offline" }, "shared leaves are not cycles");
});

test("an old exact Router generation defers normally and requires explicit force", async () => {
  const fetchImpl = async () => response(200, { ok: true, service: "codex-router", capabilities: [] });
  await assert.rejects(
    prepareRouterServiceMutation({ fetchImpl }),
    { code: "ERR_ROUTER_DRAIN_UNSUPPORTED" },
  );
  assert.deepEqual(await prepareRouterServiceMutation({ fetchImpl, force: true }), {
    status: "legacy-force",
    service: "codex-router",
  });
});

test("force never treats the wrong service identity as ownership", async () => {
  await assert.rejects(
    prepareRouterServiceMutation({
      force: true,
      fetchImpl: async () => response(200, { ok: true, service: "foreign", capabilities: [] }),
    }),
    /did not prove the owned/u,
  );
});

test("authenticated lifecycle drain propagates safe deferral and accepts drained or forced", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (url.endsWith("/live")) {
      return response(200, { ok: true, service: "codex-router", capabilities: ["drain-v1"] });
    }
    return response(409, { status: "deferred", reason: "switchyard-workflow-active", activeRequests: 0, workflows: 1 });
  };
  await assert.rejects(
    prepareRouterServiceMutation({ fetchImpl, internalKey: "internal-secret", timeoutMs: 50 }),
    (error) => {
      assert.equal(error.code, "ERR_ROUTER_DRAIN_DEFERRED");
      assert.match(error.message, /Switchyard workflows: 1.*admission was restored/u);
      return true;
    },
  );
  assert.equal(seen[1].init.headers.authorization, "Bearer internal-secret");
  assert.deepEqual(JSON.parse(seen[1].init.body), { timeout_ms: 50, force: false });

  const accepted = await prepareRouterServiceMutation({
    force: true,
    internalKey: "internal-secret",
    fetchImpl: async (url) => url.endsWith("/live")
      ? response(200, { service: "codex-router", capabilities: ["drain-v1"] })
      : response(200, { status: "forced" }),
  });
  assert.equal(accepted.status, "forced");
});

test("a longer bounded drain waits for admitted work without canceling it", async () => {
  const admission = new RouterAdmission();
  const controller = new AbortController();
  const active = admission.begin({ controller });
  let drainCalls = 0;
  const result = await prepareRouterServiceMutation({
    internalKey: "synthetic-key", timeoutMs: 90_000,
    fetchImpl: async (url, init = {}) => {
      if (url.endsWith("/live")) return response(200, { service: "codex-router", capabilities: ["drain-v1"] });
      drainCalls += 1;
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer synthetic-key");
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { timeout_ms: 90_000, force: false });
      const pending = admission.drain({ timeoutMs: body.timeout_ms, force: body.force });
      assert.equal(admission.status().state, "draining");
      assert.throws(() => admission.begin(), { code: "ERR_ROUTER_DRAINING" });
      queueMicrotask(active.finish);
      return response(200, await pending);
    },
  });
  assert.equal(result.status, "drained");
  assert.equal(controller.signal.aborted, false);
  assert.equal(admission.status().activeRequests, 0);
  assert.equal(drainCalls, 1);
});

test("invalid drain budgets fail before probing or mutating the runtime", async () => {
  for (const timeoutMs of [0, -1, NaN, 300_001, 1.5]) {
    await assert.rejects(prepareRouterServiceMutation({
      timeoutMs, fetchImpl: async () => assert.fail("invalid budget must not reach the runtime"),
    }), /Drain timeout must be an integer/u);
  }
});
