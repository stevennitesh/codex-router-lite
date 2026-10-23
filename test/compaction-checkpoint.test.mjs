import assert from "node:assert/strict";
import test from "node:test";
import { prepareCompaction, finalizeCheckpoint, renderCheckpoint, encodeCheckpoint, decodeCompaction } from "../src/compaction-checkpoint.mjs";

test("readable checkpoints preserve exact pending native items through encoding, rendering and source recataloging", () => {
  const base = finalizeCheckpoint("{}", prepareCompaction([{ role: "user", content: "Already retained request" }]));
  const retainedTail = [
    { role: "user", content: "New pending requirement" },
    { type: "function_call", name: "read", call_id: "pending_call", arguments: '{ "literal": "`$ 🌙" }' },
    { type: "function_call_output", call_id: "pending_call", output: "Actual pending tool result\nwith source whitespace" },
  ];
  const retainedTailId = "cmp_00112233445566778899aabbccddeeff";
  const encrypted = encodeCheckpoint(base, { retainedTail, retainedTailId });
  const decoded = decodeCompaction(encrypted).checkpoint;
  assert.equal(decoded.retained_tail_id, retainedTailId);
  assert.deepEqual(decoded.retained_tail, retainedTail);
  assert.equal(encodeCheckpoint(decoded), encrypted);
  for (const input of [[{ type: "compaction", encrypted_content: encrypted }], [{ role: "user", content: renderCheckpoint(decoded) }]]) {
    const prepared = prepareCompaction(input);
    assert.ok([...prepared.sources.values()].some(source => source.excerpt === "New pending requirement"));
    assert.ok([...prepared.sources.values()].some(source => source.call_id === "pending_call" && source.excerpt.includes("Actual pending tool result")));
  }
});

test("exact compaction tails reject malformed or oversized data instead of using a lossy fallback", () => {
  const base = finalizeCheckpoint("{}", prepareCompaction([]));
  const retainedTailId = "cmp_00112233445566778899aabbccddeeff";
  for (const options of [{ retainedTail: [] }, { retainedTailId }, { retainedTailId, retainedTail: [null] },
    { retainedTailId, retainedTail: [{ role: "user", content: undefined }] }]) {
    assert.throws(() => encodeCheckpoint(base, options), { code: "invalid_web_compaction_tail" });
  }
  const oversized = { ...base, retained_tail_id: retainedTailId, retained_tail: [{ role: "user", content: "x".repeat(100000) }] };
  assert.throws(() => encodeCheckpoint(oversized), { code: "web_compaction_tail_too_large", status: 413 });
  assert.throws(() => renderCheckpoint(oversized), { code: "web_compaction_tail_too_large", status: 413 });
  const malformed = `kcr2:${Buffer.from(JSON.stringify({ ...base, retained_tail: [] })).toString("base64")}`;
  assert.equal(decodeCompaction(malformed), undefined);
});

test("structured exact tails render within the existing readable-checkpoint parser bound", () => {
  const base = finalizeCheckpoint("{}", prepareCompaction([]));
  const retainedTail = [{ type: "function_call_output", call_id: "structured_pending", output: Array.from({ length: 9000 }, () => ({ a: [] })) }];
  const decoded = decodeCompaction(encodeCheckpoint(base, { retainedTail, retainedTailId: "cmp_00112233445566778899aabbccddeeff" })).checkpoint;
  assert.ok(Buffer.byteLength(JSON.stringify(decoded, null, 2), "utf8") > 256 * 1024);
  const rendered = renderCheckpoint(decoded);
  assert.ok(Buffer.byteLength(rendered, "utf8") < 256 * 1024);
  const prepared = prepareCompaction([{ role: "user", content: rendered }]);
  assert.ok([...prepared.sources.values()].some(source => source.call_id === "structured_pending"));
});

test("ambiguous serialized outcomes remain returned evidence through checkpoint replay", () => {
  for (const output of [
    '{"exit_code":7,"exit_code":0}', '{"exit_code":7,"exit\\u005fcode":0}',
    '{"structuredContent":{"exit_code":7,"exit_code":0}}',
    '{"exit_code":9007199254740993}', '{"exit_code":1e-999}', '{broken}',
  ]) {
    const input=[{role:"user",content:"Preserve outcomes"},{type:"function_call",name:"inspect",call_id:"c",arguments:"{}"},
      {type:"function_call_output",call_id:"c",output}];
    const prepared=prepareCompaction(input);
    assert.equal(prepared.sources.get("R001").outcome,"returned",output);
    assert.equal(prepared.sources.get("R001").exit_code,undefined);
    const summary={objective:"Continue",requirement_refs:["U001"],attempt_refs:["C001"],observation_refs:["R001"],unverified:[],unknowns:[],blockers:[],next_step:"Continue"};
    const checkpoint=finalizeCheckpoint(JSON.stringify(summary),prepared);
    const decoded=decodeCompaction(encodeCheckpoint(checkpoint)).checkpoint;
    assert.equal(decoded.sources.R001.outcome,"returned");
    const again=prepareCompaction([{role:"user",content:renderCheckpoint(decoded)}]);
    assert.equal(again.sources.get("R001").outcome,"returned");
    assert.equal(again.sources.get("R001").excerpt,output);
  }
  for (const [output,outcome] of [['{"exit_code":0}',"exit_0"],['{"data":{"exitCode":7}}',"exit_nonzero"]]) {
    assert.equal(prepareCompaction([{type:"function_call_output",call_id:"c",output}]).sources.get("R001").outcome,outcome);
  }
  assert.equal(prepareCompaction([{type:"function_call_output",call_id:"c",isError:true,output:'{"exit_code":7,"exit_code":0}'}]).sources.get("R001").outcome,"tool_error");
});

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
