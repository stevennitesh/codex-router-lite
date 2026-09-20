import test from "node:test";
import assert from "node:assert/strict";
import { certificationPreflight } from "../maintenance/certification-preflight.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
const checkedInRoute = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");
const route = { ...checkedInRoute, multiAgentVersion: "v2" };
test("certification preflight distinguishes source claims from native role readiness", () => {
  const state = {catalogEntry:{visibility:"list",multi_agent_version:"v2"},roleContents:routedAgentDefinition(route).contents,deployedCommit:"a".repeat(40)};
  assert.equal(certificationPreflight(route,state).readyForFreshParent,true);
  for(const changed of [{catalogEntry:{visibility:"hide",multi_agent_version:"v2"}},{roleContents:"stale"},{deployedCommit:undefined},{catalogEntry:{visibility:"list",multi_agent_version:"v1"}}]) {
    assert.equal(certificationPreflight(route,{...state,...changed}).readyForFreshParent,false);
  }
  assert.equal(certificationPreflight({...route,multiAgentVersion:"v1"},state).readyForFreshParent,false);
  assert.throws(()=>certificationPreflight(undefined),/exact registered route/);
});

test("Pareto uses its own v2 application and still rejects a v1 source", () => {
  const checkedInPareto = MODEL_BY_SLUG.get("openrouter/pareto");
  const pareto = { ...checkedInPareto, multiAgentVersion: "v2" };
  const state = {
    catalogEntry: { visibility: "list", multi_agent_version: "v2" },
    roleContents: routedAgentDefinition(pareto).contents,
    deployedCommit: "a".repeat(40),
  };
  const report = certificationPreflight(pareto, state);
  assert.equal(report.readyForFreshParent, true);
  const v1 = certificationPreflight({ ...pareto, multiAgentVersion: "v1" }, state);
  assert.equal(v1.readyForFreshParent, false);
  assert.match(v1.blockers.join("\n"), /Source route is v1/);
  assert.equal(report.application, "v2_agent/openrouter/pareto/");
});
