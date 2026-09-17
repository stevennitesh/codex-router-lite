import test from "node:test";
import assert from "node:assert/strict";
import { certificationPreflight } from "../maintenance/certification-preflight.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
const route = MODEL_BY_SLUG.get("openrouter/union-alpha");
test("certification preflight distinguishes source claims from native role readiness", () => {
  const state = {catalogEntry:{visibility:"list",multi_agent_version:"v2"},roleContents:routedAgentDefinition(route).contents,deployedCommit:"a".repeat(40)};
  assert.equal(certificationPreflight(route,state).readyForFreshParent,true);
  for(const changed of [{catalogEntry:{visibility:"hide",multi_agent_version:"v2"}},{roleContents:"stale"},{deployedCommit:undefined},{catalogEntry:{visibility:"list",multi_agent_version:"v1"}}]) {
    assert.equal(certificationPreflight(route,{...state,...changed}).readyForFreshParent,false);
  }
  assert.equal(certificationPreflight({...route,multiAgentVersion:"v1"},state).readyForFreshParent,false);
  assert.throws(()=>certificationPreflight(undefined),/exact registered route/);
});
