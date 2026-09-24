import assert from "node:assert/strict";
import test from "node:test";

import { connectTimeoutMs } from "../src/connect-timeout.mjs";
import { installStableFetchTransport } from "../src/fetch-transport.mjs";
import { fetchWithRetry } from "../src/upstream-retry.mjs";

class FakeAgent {
  constructor(options) {
    this.options = options;
    this.kind = "direct";
  }
}

class FakeProxyAgent extends FakeAgent {
  constructor(options) {
    super(options);
    this.kind = "proxy";
  }
}

function install(environment = {}) {
  let installed;
  const dispatcher = installStableFetchTransport({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeProxyAgent,
    setDispatcher(value) {
      installed = value;
    },
    environment,
    execArgv: [],
  });
  assert.equal(installed, dispatcher);
  return dispatcher;
}

function connectTimeoutError() {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(new Error("Connect Timeout Error"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  return error;
}

test("connect timeout is explicit, overridable, and clamped", () => {
  assert.equal(connectTimeoutMs({}), 3_000);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "1200" }), 1_200);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "10" }), 500);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "999999" }), 30_000);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "not-a-number" }), 3_000);
});

test("direct and opted-in proxy dispatchers share the bounded connect policy", () => {
  const direct = install({});
  assert.equal(direct.kind, "direct");
  assert.deepEqual(direct.options, {
    allowH2: false,
    pipelining: 1,
    connectTimeout: 3_000,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  });

  const proxy = install({
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://proxy.invalid:8080",
    CODEX_ROUTER_CONNECT_TIMEOUT_MS: "1500",
  });
  assert.equal(proxy.kind, "proxy");
  assert.deepEqual(proxy.options, {
    allowH2: false,
    pipelining: 1,
    connectTimeout: 1_500,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
  });
});

test("default retry budget can afford both bounded connect retries", async () => {
  let calls = 0;
  let clock = 0;
  const result = await fetchWithRetry("https://upstream.invalid/responses", {}, {
    now: () => clock,
    sleepImpl: async (delayMs) => {
      clock += delayMs;
    },
    fetchImpl: async () => {
      calls += 1;
      clock += connectTimeoutMs({});
      if (calls < 3) throw connectTimeoutError();
      return new Response("ok", { status: 200 });
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.retries, 2);
  assert.equal(result.response.status, 200);
});

test("a connect timeout that already outlived the budget is not multiplied", async () => {
  let calls = 0;
  let clock = 0;
  await assert.rejects(
    fetchWithRetry("https://upstream.invalid/responses", {}, {
      backoffMs: 0,
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        clock += 10_000;
        throw connectTimeoutError();
      },
    }),
    (error) => error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT",
  );
  assert.equal(calls, 1);
});
