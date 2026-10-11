import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { HeaderlessSseDetector, classifySsePrefix } from "../src/sse-prefix.mjs";
import { ResponseUsageTransform } from "../src/response-usage.mjs";
import { EmptyCompletionGuard } from "../src/empty-completion-guard.mjs";
import { NamespaceToolCallTransform, flattenNamespaceTools } from "../src/namespace-relay.mjs";

function detect(chunks, options) {
  const detector = new HeaderlessSseDetector(options), released = [];
  for (const chunk of chunks) released.push(...detector.write(chunk).chunks);
  const end = detector.end(); released.push(...end.chunks);
  return {decision:end.decision,bytes:Buffer.concat(released)};
}

async function run(chunks, transform) {
  const output = [];
  transform.on("data", chunk => output.push(Buffer.from(chunk)));
  await new Promise((resolve, reject) => {
    transform.once("end", resolve); transform.once("error", reject);
    Readable.from(chunks).pipe(transform);
  });
  return Buffer.concat(output);
}

test("headerless field values have only CR/LF line boundaries across every partition", () => {
  for (const separator of ["\u2028", "\u2029"]) for (const field of ["event", "data", "id", "retry"]) {
    const wire = Buffer.from(`\uFEFF: prelude\r\n\r\n${field}: value${separator}tail\n\n`);
    // A comment is already sufficient; also discriminate a complete first field.
    const fieldOnly = Buffer.from(`${field}: value${separator}tail\n\n`);
    for (const bytes of [wire, fieldOnly]) for (let split = 0; split <= bytes.length; split++) {
      const result = detect([bytes.subarray(0,split),bytes.subarray(split)]);
      assert.equal(result.decision,"event-stream",`${field} at ${split}`);
      assert.deepEqual(result.bytes,bytes);
    }
    assert.equal(classifySsePrefix(fieldOnly),"event-stream");
  }
});

test("headerless detector retains pending BOM, bare fields, other bodies and exact sniff bounds", () => {
  for (const field of ["event", "data", "id", "retry"]) {
    assert.equal(classifySsePrefix(field.slice(0,-1)),"pending");
    assert.equal(classifySsePrefix(field,{end:true}),"event-stream");
    assert.equal(classifySsePrefix(`${field}\r`),"event-stream");
  }
  assert.equal(classifySsePrefix(Buffer.from([0xef,0xbb])),"pending");
  assert.equal(classifySsePrefix(Buffer.from([0xef,0xbb]),{end:true}),"other");
  for (const wire of [Buffer.from('{"status":"completed"}'), Buffer.from("datatype: value\n"),
    Buffer.concat([Buffer.alloc(512,10),Buffer.from("data: beyond-bound\n\n")])]) {
    const result = detect([wire]); assert.equal(result.decision,"other"); assert.deepEqual(result.bytes,wire);
  }
  const atBound = Buffer.concat([Buffer.alloc(506,10),Buffer.from("data:\n")]);
  assert.equal(atBound.length,512); assert.equal(detect([atBound]).decision,"event-stream");
});

test("ordinary headerless usage, empty verdict and namespace callers agree on Unicode value partitions", async () => {
  const flat = flattenNamespaceTools([{type:"namespace",name:"fixture",tools:[{type:"function",name:"call",parameters:{type:"object"}}]}]);
  for (const separator of ["\u2028", "\u2029"]) {
    const payload = {type:"response.completed",response:{status:"completed",output:[],usage:{input_tokens:12,output_tokens:3}},padding:separator};
    const wire = Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
    for (const chunks of [[wire],[wire.subarray(0,5),wire.subarray(5)],[...wire].map(byte=>Buffer.from([byte]))]) {
      const usage = new ResponseUsageTransform("");
      assert.deepEqual(await run(chunks,usage),wire);
      assert.equal(usage.completedResponseObserved(),true);
      assert.deepEqual(usage.tokenUsage(),{inputTokens:12,outputTokens:3,totalTokens:15});
      const empty = new EmptyCompletionGuard("");
      assert.equal((await run(chunks,empty)).length,0); assert.equal(empty.isEmpty(),true);
      const call = {type:"response.output_item.done",item:{type:"function_call",name:flat.tools[0].name,arguments:"{}",call_id:"fixture-call"},padding:separator};
      const callWire = Buffer.from(`data: ${JSON.stringify(call)}\n\n`);
      const callChunks = chunks.length === 1 ? [callWire] : [...callWire].map(byte=>Buffer.from([byte]));
      const restored = await run(callChunks,new NamespaceToolCallTransform(flat.namespaces,""));
      const item = JSON.parse(restored.toString().slice(5)).item;
      assert.equal(item.name,"call"); assert.equal(item.namespace,"fixture"); assert.equal(item.call_id,"fixture-call");
    }
    const explicitJson = new ResponseUsageTransform("application/json");
    assert.deepEqual(await run([wire],explicitJson),wire);
    assert.equal(explicitJson.completedResponseObserved(),false);
  }
});
