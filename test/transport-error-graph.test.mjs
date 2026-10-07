import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetry } from "../src/upstream-retry.mjs";
import { describeTransportFailure } from "../src/transport-failure.mjs";
import { waitForRouterHealth } from "../src/router-health.mjs";

const refused = () => Object.assign(new Error("connection refused"),{code:"ECONNREFUSED",hostname:"localhost"});
const wrapped = members => new TypeError("fetch failed",{cause:new AggregateError(members)});
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
