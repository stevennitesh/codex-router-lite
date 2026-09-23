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
