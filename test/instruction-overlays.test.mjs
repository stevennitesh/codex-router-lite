import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDelegatedAgentWaitPolicy,
  DELEGATED_AGENT_WAIT_POLICY,
} from "../src/instruction-overlays.mjs";

test("delegated-agent waits receive one scoped silence exception", () => {
  const once = applyDelegatedAgentWaitPolicy("BASE");
  assert.equal(once, `BASE\n\n${DELEGATED_AGENT_WAIT_POLICY}`);
  assert.equal(applyDelegatedAgentWaitPolicy(once), once);
  assert.match(once, /exclusive custody/u);
  assert.match(once, /60-second commentary cadence/u);
  assert.match(once, /Wait again without commentary/u);
  assert.match(once, /new user input can wake the wait early/u);
});

test("missing request instructions remain absent", () => {
  assert.equal(applyDelegatedAgentWaitPolicy(undefined), undefined);
  assert.equal(applyDelegatedAgentWaitPolicy(""), "");
});
