import assert from "node:assert/strict";
import test from "node:test";

import { prepareRouterServiceMutation } from "../src/service-drain.mjs";

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
    return response(409, { status: "deferred", reason: "switchyard-workflow-active" });
  };
  await assert.rejects(
    prepareRouterServiceMutation({ fetchImpl, internalKey: "internal-secret", timeoutMs: 50 }),
    { code: "ERR_ROUTER_DRAIN_DEFERRED" },
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

test("idle wait observes settling activity before its single authenticated drain", async () => {
  const seen = [];
  let observations = 0;
  const result = await prepareRouterServiceMutation({
    internalKey: "synthetic-key", waitForIdleMs: 2_000,
    fetchImpl: async (url, init = {}) => {
      seen.push({ url, init });
      if (url.endsWith("/live")) return response(200, { service: "codex-router", capabilities: ["drain-v1"] });
      assert.equal(init.headers.authorization, "Bearer synthetic-key");
      if (url.endsWith("/internal/lifecycle")) {
        assert.equal(init.method, undefined, "waiting must leave admission unchanged");
        observations += 1;
        return response(200, { capability: "drain-v1", state: "open", activeRequests: observations === 1 ? 1 : 0, workflows: 0, indeterminateWorkflow: false });
      }
      assert.equal(observations, 2, "must observe idle before draining");
      assert.deepEqual(JSON.parse(init.body), { timeout_ms: 30_000, force: false });
      return response(200, { status: "drained" });
    },
  });
  assert.equal(result.status, "drained");
  assert.equal(seen.filter(({ init }) => init.method === "POST").length, 1);
});

test("persistent workflows exhaust idle waiting without changing admission", async () => {
  await assert.rejects(prepareRouterServiceMutation({
    internalKey: "synthetic-key", waitForIdleMs: 20,
    fetchImpl: async (url, init = {}) => {
      assert.notEqual(init.method, "POST", "must not drain or resume an unsettled workflow");
      return url.endsWith("/live")
        ? response(200, { service: "codex-router", capabilities: ["drain-v1"] })
        : response(200, { capability: "drain-v1", state: "open", activeRequests: 0, workflows: 1, indeterminateWorkflow: false });
    },
  }), (error) => {
    assert.equal(error.code, "ERR_ROUTER_DRAIN_DEFERRED");
    assert.match(error.message, /1 Switchyard workflows.*admission was left open/u);
    return true;
  });
});

test("idle waiting fails closed on incomplete status or another operation", async () => {
  const idle = { capability: "drain-v1", state: "open", activeRequests: 0, workflows: 0, indeterminateWorkflow: false };
  for (const status of [
    { ...idle, capability: "foreign" }, { ...idle, activeRequests: undefined },
    { ...idle, workflows: -1 }, { ...idle, indeterminateWorkflow: undefined },
    { ...idle, state: "closed" },
  ]) {
    await assert.rejects(prepareRouterServiceMutation({
      internalKey: "synthetic-key", waitForIdleMs: 100,
      fetchImpl: async (url, init = {}) => {
        assert.notEqual(init.method, "POST");
        return url.endsWith("/live")
          ? response(200, { service: "codex-router", capabilities: ["drain-v1"] })
          : response(200, status);
      },
    }), /refusing.*service mutation/u);
  }
});

test("work arriving after an idle observation still defers the guarded drain", async () => {
  await assert.rejects(prepareRouterServiceMutation({
    internalKey: "synthetic-key", waitForIdleMs: 100,
    fetchImpl: async (url) => url.endsWith("/live")
      ? response(200, { service: "codex-router", capabilities: ["drain-v1"] })
      : url.endsWith("/internal/lifecycle")
        ? response(200, { capability: "drain-v1", state: "open", activeRequests: 0, workflows: 0, indeterminateWorkflow: false })
        : response(409, { status: "deferred", reason: "switchyard-workflow-active" }),
  }), { code: "ERR_ROUTER_DRAIN_DEFERRED" });
});
