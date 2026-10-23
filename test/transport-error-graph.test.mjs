import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { Agent, fetch } from "undici";
import { fetchWithRetry } from "../src/upstream-retry.mjs";
import { describeTransportFailure } from "../src/transport-failure.mjs";
import { waitForRouterHealth } from "../src/router-health.mjs";

const refused = () => Object.assign(new Error("connection refused"),{code:"ECONNREFUSED",hostname:"localhost"});
const wrapped = members => new TypeError("fetch failed",{cause:new AggregateError(members)});

test("real HTTP/1 connect failures identify the failed local endpoint without claiming ownership", async () => {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const dispatcher = new Agent({ allowH2: false });
  try {
    const error = await fetch(`http://127.0.0.1:${port}`, { dispatcher }).then(() => assert.fail("closed endpoint answered"), error => error);
    const failure = describeTransportFailure(error, { proxyConfigured: false });
    assert.equal(failure.code, "ECONNREFUSED");
    assert.match(failure.cause, /127\.0\.0\.1 refused/u);
    assert.match(failure.hint, /local endpoint/u);
    assert.doesNotMatch(failure.hint, /own processes|not the network/u);
    assert.match(describeTransportFailure(error, { proxyConfigured: true }).hint, /local service or configured proxy/u);
  } finally { await dispatcher.close(); }
});

test("host diagnosis accepts bounded host fields and rejects addresses carrying private data", () => {
  const diagnose = fields => describeTransportFailure(Object.assign(new Error("connection failed"), { code: "ECONNREFUSED", ...fields }), { proxyConfigured: false });
  for (const address of ["::1", "[::1]", "127.2.3.4"]) {
    const result = diagnose({ address, syscall: "connect" });
    assert.ok(result.cause.includes(address)); assert.match(result.hint, /local endpoint/u);
  }
  assert.match(diagnose({ hostname: "gateway.example", address: "127.0.0.1", syscall: "connect" }).cause, /gateway\.example/u);
  assert.match(diagnose({ hostname: "127.example.invalid" }).hint, /outbound proxy/u);
  assert.match(diagnose({ address: "127.0.0.1", syscall: "read" }).cause, /the upstream/u);
  for (const value of ["https://user:PRIVATE@example.invalid/path", "user@PRIVATE", "host\nPRIVATE", "[::1]PRIVATE", "x".repeat(254)]) {
    for (const key of ["hostname", "address"]) {
      const result = diagnose({ [key]: value, syscall: "connect" });
      assert.match(result.cause, /the upstream/u); assert.ok(!result.cause.includes("PRIVATE"));
    }
  }
  assert.match(diagnose({ message: "Connect Timeout (attempted address: [::1]:4200)" }).cause, /\[::1\]/u);
});
async function retryOutcome(error, canRetry = () => true) {
  let attempts = 0;
  const outcome = await fetchWithRetry("http://upstream.invalid",{}, {
    retries:1,backoffMs:0,budgetMs:1000,canRetry,sleepImpl:async()=>{},
    fetchImpl:async()=>{ if (++attempts === 1) throw error; return new Response("ok"); },
  }).catch(failure => failure);
  return {attempts,outcome};
}

test("aggregate connection failures share traversal without merging caller policies", async () => {
  const error = wrapped([refused(),refused()]);
  const {attempts,outcome} = await retryOutcome(error);
  assert.equal(attempts,2); assert.equal(outcome.retries,1);
  assert.equal(describeTransportFailure(error,{proxyConfigured:true}).code,"ECONNREFUSED");
  const health = await waitForRouterHealth({timeoutMs:0,fetchImpl:async()=>{throw error;}});
  assert.equal(health.connectionRefused,true);
  const mixed = wrapped([refused(),Object.assign(new Error("socket reset"),{code:"ECONNRESET"})]);
  assert.equal((await retryOutcome(mixed)).attempts,2);
  assert.equal((await waitForRouterHealth({timeoutMs:0,fetchImpl:async()=>{throw mixed;}})).connectionRefused,false);
});

test("unknown, aborted, local-status, cyclic and oversized errors do not become retries", async () => {
  const cyclic = refused(); cyclic.cause = cyclic;
  const deep = refused(); let current = deep;
  for(let index=0;index<10;index++) current = current.cause = refused();
  const failures = [
    wrapped([refused(),new Error("unknown cause")]),
    wrapped([refused(),Object.assign(new Error("abort"),{name:"AbortError"})]),
    wrapped([refused(),Object.assign(new Error("timeout"),{name:"TimeoutError"})]),
    wrapped([refused(),Object.assign(new Error("local failure"),{status:413})]),
    wrapped([refused(),Object.assign(new Error("unknown code"),{code:"UNKNOWN"})]),
    cyclic,wrapped([refused(),cyclic]),deep,wrapped(Array.from({length:257},refused)),
  ];
  for(const error of failures) {
    const result = await retryOutcome(error);
    assert.equal(result.attempts,1); assert.equal(result.outcome,error);
    assert.equal((await waitForRouterHealth({timeoutMs:0,fetchImpl:async()=>{throw error;}})).connectionRefused,false);
  }
  assert.equal((await retryOutcome(wrapped([refused()]),()=>false)).attempts,1,"partial output blocks retry");
});
