import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { certificationBatchPreflight, certificationPreflight, certificationRoutes } from "../maintenance/certification-preflight.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { CHECKED_IN_MODELS, MODEL_BY_SLUG } from "../src/routed-models.mjs";
const checkedInRoute = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash-streamlake");
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

test("route selection preserves an exact ordered subset and rejects ambiguous requests", () => {
  const slugs = ["switchyard/auto", "openrouter/deepseek-v4.1-flash-together"];
  assert.deepEqual(certificationRoutes(slugs).map(route => route.slug), slugs);
  assert.deepEqual(certificationRoutes(["--all"]), CHECKED_IN_MODELS);
  for (const args of [[], ["--all", slugs[0]], ["--unknown"], [slugs[0], slugs[0]], ["openrouter/not-registered"]]) {
    assert.throws(() => certificationRoutes(args));
  }
});

test("batch preflight reads shared state once and retains per-route readiness", () => {
  const routes = certificationRoutes(["switchyard/auto", "openrouter/deepseek-v4.1-flash-together"]).map(route => ({ ...route, multiAgentVersion: "v2" }));
  const catalog = { models: routes.map(route => ({slug:route.slug,visibility:"list",multi_agent_version:"v2"})) };
  const files = new Map([
    ["catalog", JSON.stringify(catalog)],
    ["manifest", JSON.stringify({current:{commit:"b".repeat(40)}})],
    ...routes.map(route => [path.join("roles", routedAgentDefinition(route).fileName), routedAgentDefinition(route).contents]),
  ]);
  const reads = [];
  const options = {catalogPath:"catalog",manifestPath:"manifest",agentsDir:"roles",read:file => {reads.push(file); return files.get(file);}};
  const batch = certificationBatchPreflight(routes, options);
  assert.equal(batch.readyForFreshParent, true);
  assert.equal(batch.runManifestTemplate.routerCommit, "b".repeat(40));
  assert.deepEqual(batch.runManifestTemplate.routes, batch.reports.map(({slug,firstMarker,secondMarker}) => ({slug,firstMarker,secondMarker})));
  for (const field of ["startedAt","endedAt","parentSessionId","codexVersion","windowsAppVersion","executionSurface","windowsSandbox"]) assert.equal(batch.runManifestTemplate[field], "");
  assert.deepEqual(batch.reports.map(report => report.slug), routes.map(route => route.slug));
  assert.equal(reads.length, 2 + routes.length);
  assert.equal(reads.filter(file => file === "catalog").length, 1);
  assert.equal(reads.filter(file => file === "manifest").length, 1);
  files.delete(path.join("roles", routedAgentDefinition(routes[1]).fileName));
  const partial = certificationBatchPreflight(routes, options);
  assert.equal(partial.readyForFreshParent, false);
  assert.equal(partial.reports[0].readyForFreshParent, true);
  assert.equal(partial.reports[1].readyForFreshParent, false);
  assert.equal(certificationBatchPreflight([{...routes[0],multiAgentVersion:"v1"}], options).readyForFreshParent, false);
  assert.throws(() => certificationBatchPreflight(routes, {...options,read:() => {throw Object.assign(new Error("denied"), {code:"EACCES"});}}), {code:"EACCES"});
});

test("draft plans carry exact identity while observations and acceptance remain pending", () => {
  const requiredObservations = ["testedAt", "routerVersion", "codexVersion", "executionSurface"];
  for (const route of CHECKED_IN_MODELS) {
    const { draftProof: proof } = certificationPreflight(route, {deployedCommit:"c".repeat(40)});
    assert.equal(proof.slug, route.slug);
    assert.equal(proof.provider, route.provider);
    assert.equal(proof.model, route.upstreamModel);
    assert.equal(proof.status, "draft");
    assert.equal(proof.routerCommit, "c".repeat(40));
    for (const key of requiredObservations) assert.equal(proof[key], "");
    assert.deepEqual(Object.keys(proof.checks).sort(), ["streaming", "toolCall", "encryptedRelay", "markerReturn", "sameThreadFollowUp"].sort());
    for (const check of Object.values(proof.checks)) assert.deepEqual(check, {outcome:"pending"});
    if (route.provider === "openrouter") {
      assert.equal(proof.endpointProvider, route.openRouterProviderPolicy.only[0]);
      assert.equal(Object.hasOwn(proof, "runtimeBinding"), false);
    } else {
      assert.equal(Object.hasOwn(proof, "endpointProvider"), false);
      assert.ok(Object.values(proof.runtimeBinding).every(value => value === ""));
    }
    proof.checks.streaming.outcome = "pass";
    assert.equal(certificationPreflight(route).draftProof.checks.streaming.outcome, "pending");
  }
  const template = JSON.parse(readFileSync(new URL("../v2_agent/_template/proof.json", import.meta.url), "utf8"));
  for (const key of requiredObservations) assert.equal(template[key], "");
});

test("CLI preserves single-route output and emits complete batch plans without changing local state", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "router-preflight-"));
  try {
    const state = path.join(home, "state"), agents = path.join(home, "agents");
    mkdirSync(state); mkdirSync(agents);
    const catalog = JSON.stringify({models:CHECKED_IN_MODELS.map(route => ({slug:route.slug,visibility:"list",multi_agent_version:"v2"}))});
    const manifest = JSON.stringify({current:{commit:"d".repeat(40)}});
    writeFileSync(path.join(state, "merged-models.json"), catalog);
    writeFileSync(path.join(state, "install-manifest.json"), manifest);
    for (const route of CHECKED_IN_MODELS) {
      const role = routedAgentDefinition(route);
      writeFileSync(path.join(agents, role.fileName), role.contents);
    }
    const run = args => JSON.parse(execFileSync(process.execPath, ["maintenance/certification-preflight.mjs", ...args], {
      encoding:"utf8", windowsHide:true,
      env:{...process.env,CODEX_HOME:home,MODEL_ROUTER_STATE_DIR:state},
    }));
    const slug = CHECKED_IN_MODELS[0].slug;
    assert.equal(run([slug]).slug, slug);
    const batchRun = spawnSync(process.execPath, ["maintenance/certification-preflight.mjs", "--all"], {
      encoding:"utf8", windowsHide:true,
      env:{...process.env,CODEX_HOME:home,MODEL_ROUTER_STATE_DIR:state},
    });
    const batch = JSON.parse(batchRun.stdout);
    const expectedReady = CHECKED_IN_MODELS.every(route => route.multiAgentVersion === "v2");
    assert.equal(batchRun.status, expectedReady ? 0 : 1);
    assert.equal(batch.readyForFreshParent, expectedReady);
    for (const report of batch.reports) assert.equal(report.readyForFreshParent, MODEL_BY_SLUG.get(report.slug).multiAgentVersion === "v2");
    assert.deepEqual(batch.reports.map(report => report.slug), CHECKED_IN_MODELS.map(route => route.slug));
    assert.equal(readFileSync(path.join(state, "merged-models.json"), "utf8"), catalog);
    assert.equal(readFileSync(path.join(state, "install-manifest.json"), "utf8"), manifest);
    const hiddenCatalog = JSON.stringify({models:[{slug,visibility:"hide",multi_agent_version:"v2"}]});
    writeFileSync(path.join(state, "merged-models.json"), hiddenCatalog);
    const options = {encoding:"utf8",windowsHide:true,env:{...process.env,CODEX_HOME:home,MODEL_ROUTER_STATE_DIR:state}};
    const blocked = spawnSync(process.execPath, ["maintenance/certification-preflight.mjs", slug], options);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).readyForFreshParent, false);
    const unknown = spawnSync(process.execPath, ["maintenance/certification-preflight.mjs", "unknown/route"], options);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown exact route/);
    assert.equal(readFileSync(path.join(state, "merged-models.json"), "utf8"), hiddenCatalog);
    assert.equal(readFileSync(path.join(state, "install-manifest.json"), "utf8"), manifest);
  } finally {
    rmSync(home, {recursive:true,force:true});
  }
});
