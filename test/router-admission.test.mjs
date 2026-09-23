import assert from "node:assert/strict";
import test from "node:test";

import {
  clientToolCalls,
  clientToolOutputs,
  RouterAdmission,
  SWITCHYARD_CALLBACK_LEASE_HEADER,
  switchyardWorkflowIdentity,
} from "../src/router-admission.mjs";

test("drain closes admission, lets active work settle, and timeout resumes", async () => {
  const admission = new RouterAdmission();
  const active = admission.begin({ controller: new AbortController() });
  const draining = admission.drain({ timeoutMs: 1_000 });
  assert.throws(() => admission.begin(), { code: "ERR_ROUTER_DRAINING" });
  active.finish();
  assert.equal((await draining).status, "drained");
  assert.throws(() => admission.begin(), { code: "ERR_ROUTER_DRAINING" });
  admission.resume();

  const held = admission.begin();
  const deferred = await admission.drain({ timeoutMs: 5 });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.reason, "timeout");
  const next = admission.begin();
  next.finish();
  held.finish();
});

test("only a callback lease belonging to admitted Switchyard work crosses a closed gate", async () => {
  const admission = new RouterAdmission();
  const outer = admission.begin();
  const lease = outer.issueSwitchyardCallbackLease();
  const draining = admission.drain({ timeoutMs: 1_000 });
  const headers = { [SWITCHYARD_CALLBACK_LEASE_HEADER]: lease };
  const consumed = admission.consumeSwitchyardCallbackLease(headers);
  assert.equal(headers[SWITCHYARD_CALLBACK_LEASE_HEADER], undefined);
  const nested = admission.begin({ nestedCallbackLease: consumed });
  assert.throws(() => admission.begin({ nestedCallbackLease: "wrong" }), {
    code: "ERR_ROUTER_DRAINING",
  });
  nested.finish();
  outer.finish();
  assert.equal((await draining).status, "drained");
});

test("Switchyard tool workflows defer replacement across an idle client tool gap", async () => {
  const admission = new RouterAdmission();
  admission.recordSwitchyardWorkflow({
    identity: "session:one",
    produced: ["call-1"],
  });
  const deferred = await admission.drain({ timeoutMs: 50 });
  assert.equal(deferred.status, "deferred");
  assert.equal(deferred.reason, "switchyard-workflow-active");
  assert.equal(admission.status().state, "open");

  const continuation = admission.begin();
  const draining = admission.drain({ timeoutMs: 1_000 });
  admission.recordSwitchyardWorkflow({
    identity: "session:one",
    consumed: ["call-1"],
    produced: ["call-2"],
  });
  assert.equal((await draining).status, "deferred");
  assert.equal(admission.status().state, "open");
  continuation.finish();

  admission.recordSwitchyardWorkflow({
    identity: "session:one",
    consumed: ["call-2"],
    produced: [],
  });
  assert.equal((await admission.drain()).status, "drained");
});

test("a tool call produced by already admitted work reopens admission and defers drain", async () => {
  const admission = new RouterAdmission();
  const active = admission.begin();
  const draining = admission.drain({ timeoutMs: 1_000 });
  admission.recordSwitchyardWorkflow({
    identity: "session:late-tool",
    produced: ["call-late"],
  });
  const result = await draining;
  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "switchyard-workflow-active");
  const admitted = admission.begin();
  admitted.finish();
  active.finish();
});

test("indeterminate and over-capacity workflows never become idle through eviction or expiry", async () => {
  const admission = new RouterAdmission();
  admission.recordSwitchyardWorkflow({ produced: ["unknown-owner"] });
  assert.equal(admission.status().indeterminateWorkflow, true);
  assert.equal((await admission.drain()).status, "deferred");
  const forced = await admission.drain({ force: true });
  assert.equal(forced.status, "forced");
  assert.equal(forced.indeterminateWorkflow, false);

  const capacity = new RouterAdmission();
  for (let index = 0; index <= 256; index += 1) {
    capacity.recordSwitchyardWorkflow({
      identity: `session:${index}`,
      produced: [`call:${index}`],
    });
  }
  assert.equal(capacity.status().workflows, 256);
  assert.equal(capacity.status().indeterminateWorkflow, true);
});

test("force cancels active work and peers while tool parsing excludes hosted provider calls", async () => {
  const admission = new RouterAdmission();
  const controller = new AbortController();
  admission.begin({ controller });
  let closed = false;
  admission.registerPeer({ forceClose: () => { closed = true; } });
  assert.deepEqual(clientToolCalls([
    { type: "function_call", call_id: "fc" },
    { type: "tool_search_call", id: "ts" },
    { type: "web_search_call", id: "hosted" },
  ]), ["fc", "ts"]);
  assert.deepEqual(clientToolOutputs([
    { type: "function_call_output", call_id: "fc" },
    { type: "tool_search_output", id: "ts" },
    { type: "web_search_call", id: "hosted" },
  ]), ["fc", "ts"]);
  await admission.drain({ force: true });
  assert.equal(controller.signal.aborted, true);
  assert.equal(closed, true);
});

test("workflow identity uses consistent session headers or bounded turn metadata", () => {
  assert.equal(switchyardWorkflowIdentity({ "x-session-id": "abc" }), "session:abc");
  assert.equal(switchyardWorkflowIdentity({
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-1" }),
  }), "turn:thread-1");
  assert.equal(switchyardWorkflowIdentity({ "session-id": "a", "x-session-id": "b" }), undefined);
});
