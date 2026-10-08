import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { openPort } from "./port-pool.mjs";
import { fetchWithRetry } from "../src/upstream-retry.mjs";

const failure = (code, extra = {}) => new TypeError("fetch failed", {
  cause: Object.assign(new Error("synthetic transport failure"), { code, ...extra }),
});

test("POST retries require conclusive connection failure across the complete error graph", async () => {
  for (const [error, expected] of [
    ...["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"].map(code => [failure(code), 2]),
    [failure("ETIMEDOUT", { syscall: "connect" }), 2],
    [failure("ENOBUFS", { syscall: "connect" }), 2],
    ...["ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT", "ENOBUFS", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"].map(code => [failure(code), 1]),
    [new AggregateError([failure("ECONNREFUSED"), failure("ECONNRESET")]), 1],
    [failure("UND_ERR_HEADERS_TIMEOUT", { syscall: "connect" }), 1],
  ]) {
    let calls = 0;
    const result = await fetchWithRetry("https://synthetic.invalid", { method: "POST", body: "same input" }, {
      retries: 1, backoffMs: 0, fetchImpl: async () => {
        if (++calls === 1) throw error;
        return new Response("done");
      },
    }).catch(value => value);
    assert.equal(calls, expected, error.cause?.code);
    if (expected === 1) assert.equal(result, error);
    else assert.equal(result.retries, 1);
  }
});

test("POST edge statuses are returned once while idempotent status recovery remains bounded", async () => {
  for (const method of ["POST", "PATCH", "GET", "HEAD"]) {
    for (const status of [502, 503, 504, 520, 524, 429, 500]) {
      let calls = 0;
      const result = await fetchWithRetry("https://synthetic.invalid", { method }, {
        retries: 1, backoffMs: 0,
        fetchImpl: async () => ++calls === 1 ? new Response("original refusal", { status }) : new Response("done"),
      });
      const retries = ["GET", "HEAD"].includes(method) && ![429, 500].includes(status) ? 1 : 0;
      assert.equal(calls, 1 + retries);
      assert.equal(result.retries, retries);
      assert.equal(await result.response.text(), retries ? "done" : "original refusal");
    }
  }
  let calls = 0;
  await fetchWithRetry(new Request("https://synthetic.invalid", { method: "POST", body: "input" }), {}, {
    backoffMs: 0, fetchImpl: async () => { calls++; return new Response("refused", { status: 503 }); },
  });
  assert.equal(calls, 1, "Request-owned method is not mistaken for GET");
});

test("retry permission and budget changes during backoff keep the original refusal readable", async () => {
  for (const reason of ["permission", "budget"]) {
    let clock = 0, calls = 0, allowed = true, notifications = 0;
    const refusal = new Response("useful refusal", { status: 503, headers: { "retry-after": "7" } });
    const result = await fetchWithRetry("https://synthetic.invalid", {}, {
      retries: 1, backoffMs: 10, budgetMs: 100, now: () => clock, canRetry: () => allowed,
      onRetry: () => notifications++,
      sleepImpl: async () => { if (reason === "permission") allowed = false; else clock = 101; },
      fetchImpl: async () => { calls++; return refusal; },
    });
    assert.equal(calls, 1); assert.equal(result.retries, 0); assert.equal(notifications, 0);
    assert.equal(result.response, refusal);
    assert.equal(await result.response.text(), "useful refusal");
    assert.equal(result.response.headers.get("retry-after"), "7");
  }
});

test("backoff that cannot fit the remaining budget does not wait or discard the refusal", async () => {
  let waits = 0, calls = 0;
  const result = await fetchWithRetry("https://synthetic.invalid", {}, {
    retries: 1, backoffMs: 10, budgetMs: 5, now: () => 0,
    sleepImpl: async () => waits++, fetchImpl: async () => { calls++; return new Response("refused", { status: 503 }); },
  });
  assert.equal(calls, 1); assert.equal(waits, 0); assert.equal(result.retries, 0);
  assert.equal(await result.response.text(), "refused");
});

test("permission or budget lost during cancellation prevents dispatch without waiting for cancel", async () => {
  for (const reason of ["permission", "budget"]) {
    let clock = 0, calls = 0, allowed = true, canceled = 0;
    const refusal = new Response(new ReadableStream({ cancel() {
      canceled++;
      if (reason === "permission") allowed = false; else clock = 101;
      return new Promise(() => {});
    } }), { status: 503, headers: { "retry-after": "7", "content-length": "100", "content-encoding": "gzip" } });
    const result = await fetchWithRetry("https://synthetic.invalid", {}, {
      retries: 1, backoffMs: 0, budgetMs: 100, now: () => clock, canRetry: () => allowed,
      fetchImpl: async () => { calls++; return refusal; },
    });
    assert.equal(calls, 1); assert.equal(canceled, 1); assert.equal(result.retries, 0);
    assert.equal(result.response.status, 503); assert.equal(await result.response.text(), "");
    assert.equal(result.response.headers.get("retry-after"), "7");
    assert.equal(result.response.headers.get("content-length"), null);
    assert.equal(result.response.headers.get("content-encoding"), null);
  }
});

test("caller cancellation during backoff cancels the refusal without an extra attempt", async () => {
  let calls = 0, canceled = 0;
  const controller = new AbortController();
  const refusal = new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 503 });
  await assert.rejects(fetchWithRetry("https://synthetic.invalid", { signal: controller.signal }, {
    retries: 1, backoffMs: 10, sleepImpl: async () => controller.abort(),
    fetchImpl: async () => { calls++; return refusal; },
  }), { name: "AbortError" });
  assert.equal(calls, 1); assert.equal(canceled, 1);
});

test("actual conclusive connection refusal recovers one byte-identical POST", async t => {
  const port = await openPort();
  const accepted = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    accepted.push(Buffer.concat(chunks));
    response.end("done");
  });
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  const input = Buffer.from("synthetic POST with Unicode 漢🙂");
  const events = [];
  const result = await fetchWithRetry(`http://127.0.0.1:${port}/responses`, { method: "POST", body: input }, {
    retries: 1, backoffMs: 0,
    onRetry: event => { events.push(event); server.listen(port, "127.0.0.1"); },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].error.cause.code, "ECONNREFUSED");
  assert.equal(result.retries, 1); assert.equal(await result.response.text(), "done");
  assert.deepEqual(accepted, [input]);
});
