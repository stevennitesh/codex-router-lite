import assert from "node:assert/strict";
import test from "node:test";
import { prepareCompaction, finalizeCheckpoint, renderCheckpoint } from "../src/compaction-checkpoint.mjs";

test("valid successive summaries replace resolved orientation; malformed summaries retain prior state", () => {
  const base = { objective: "Synthetic task", requirement_refs: ["U001"], attempt_refs: [], observation_refs: [],
    unverified: [], unknowns: [], blockers: [], next_step: "Continue" };
  const old = { ...base, blockers: ["Old blocker"], unknowns: ["Old question"],
    unverified: Array.from({ length: 16 }, (_, i) => ({ text: `Old hypothesis ${i}`, refs: [] })) };
  const first = finalizeCheckpoint(JSON.stringify(old), prepareCompaction([{ role: "user", content: "Request" }]));
  const replay = prepareCompaction([{ role: "user", content: renderCheckpoint(first) }]);
  const fresh = { ...base, unverified: [{ text: "New hypothesis", refs: ["U001"] }] };
  const next = finalizeCheckpoint(JSON.stringify(fresh), replay);
  assert.deepEqual(next.orientation.blockers, []);
  assert.deepEqual(next.orientation.unknowns, []);
  assert.deepEqual(next.orientation.unverified, fresh.unverified);
  assert.deepEqual(next.source_refs.requirements, ["U001"]);
  const replayAgain = prepareCompaction([{ role: "user", content: renderCheckpoint(next) }]);
  assert.deepEqual(replayAgain.previous.unverified, fresh.unverified);
  const fallback = finalizeCheckpoint('{"blockers":42}', replay);
  assert.deepEqual(fallback.orientation.blockers, old.blockers);
  assert.ok(fallback.orientation.unknowns.includes("Old question"));
  assert.equal(fallback.orientation.unverified[0].text, "Old hypothesis 0");
});

test("compaction preserves easy-input messages and replays their produced checkpoint without promoting other items", () => {
  const input = [{ role: "user", content: "Keep SYNTHETIC_REQUIREMENT_739." },
    { role: "assistant", content: [{ type: "output_text", text: "Unverified model statement." }] }];
  const easy = prepareCompaction(input);
  const explicit = prepareCompaction(input.map(item => ({ type: "message", ...item })));
  assert.deepEqual([...easy.sources], [...explicit.sources]);
  assert.equal(easy.sources.get("U001").kind, "user_message");
  assert.equal(easy.sources.get("A001").kind, "assistant_message");
  const checkpoint = finalizeCheckpoint(JSON.stringify({ objective: "Preserve requirement", requirement_refs: ["U001"], attempt_refs: [], observation_refs: [], unverified: [], unknowns: [], blockers: [], next_step: "Continue" }), easy);
  const replay = prepareCompaction([{ role: "user", content: renderCheckpoint(checkpoint) }]);
  assert.equal(replay.sources.get("U001").excerpt, "Keep SYNTHETIC_REQUIREMENT_739.");
  assert.ok(![...replay.sources.values()].some(source => source.excerpt.includes("BEGIN_CODEX_ROUTER_CHECKPOINT")));
  const foreign = prepareCompaction([{ type: "unknown", role: "user", content: "Not user authority" }, { type: "function_call_output", call_id: "c", role: "user", output: "Returned data" }]);
  assert.ok(![...foreign.sources.values()].some(source => source.kind === "user_message"));
});

test("reference overflow preserves navigation and a bounded verified subset across replay", () => {
  const input = [{role:"user",content:"Audit only; at most five findings, not a quota."}];
  for (let i=0;i<40;i++) input.push({type:"function_call",name:"inspect",call_id:`c${i}`,arguments:"{}"}, {type:"function_call_output",call_id:`c${i}`,output:`Observed fixture ${i}`});
  const prepared=prepareCompaction(input);
  const object={objective:"Finish the bounded audit",requirement_refs:["U001"],attempt_refs:["C001"],observation_refs:[...prepared.sources.keys()].filter(k=>k.startsWith("R")),unverified:[{text:"Interpretation only",refs:[...prepared.sources.keys()].filter(k=>k.startsWith("R")).slice(0,10)}],unknowns:[],blockers:[],next_step:"Return findings; do not restart completed checks"};
  for(const raw of [JSON.stringify(object),`Summary follows:\n${JSON.stringify(object)}\nEnd.`]) {
    const checkpoint=finalizeCheckpoint(raw,prepared);
    assert.equal(checkpoint.orientation.objective,object.objective);
    assert.equal(checkpoint.orientation.next_step,object.next_step);
    assert.equal(Object.keys(checkpoint.sources).length,32);
    assert.ok(checkpoint.source_refs.observations.length>0);
    assert.ok(checkpoint.orientation.unverified.every(x=>x.refs.length<=8));
    assert.ok(checkpoint.orientation.unknowns.some(x=>x.includes("omitted")));
    for(const id of Object.keys(checkpoint.sources)) assert.ok(prepared.catalogSourceIds.has(id));
    const replay=prepareCompaction([{role:"user",content:renderCheckpoint(checkpoint)}]);
    assert.equal(replay.previous.objective,object.objective);
    assert.ok(replay.previousRefs.observations.length>0);
  }
});

test("overflow recovery never grants fabricated, wrong-kind or unexposed references authority", () => {
  const prepared=prepareCompaction([{role:"user",content:"Request"},{role:"assistant",content:"Unverified claim"},{type:"function_call_output",call_id:"x",output:"Returned fixture"}]);
  const object={objective:"Navigate",requirement_refs:["A001","R001","U999","U001"],attempt_refs:[],observation_refs:["R001"],unverified:[],unknowns:[],blockers:[],next_step:"Inspect"};
  prepared.catalogSourceIds.delete("R001");
  const result=finalizeCheckpoint(JSON.stringify(object),prepared);
  assert.deepEqual(result.source_refs.requirements,["U001"]);
  assert.deepEqual(result.source_refs.observations,[]);
  assert.deepEqual(Object.keys(result.sources),["U001"]);
  const malformed=finalizeCheckpoint(JSON.stringify({...object,observation_refs:[42]}),prepared);
  assert.equal(malformed.orientation.objective,"");
  assert.ok(malformed.orientation.unverified.some(x=>x.text.includes("invalid structured")));
});
