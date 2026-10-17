import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { decodeCompaction, prepareCompaction } from "../src/compaction-checkpoint.mjs";
import { MessagePhaseTransform } from "../src/message-phase.mjs";
import { NamespaceToolCallTransform } from "../src/namespace-relay.mjs";
import { ResponseUsageTransform, responseTerminalOutcome } from "../src/response-usage.mjs";
import { SseFrameBuffer, sseFrameFields } from "../src/sse-framing.mjs";
import { createWebToolBroker } from "../src/web-tools.mjs";
import { webCompactResponse, webResponse } from "../src/web-response.mjs";

const model = "chatgpt-web/gpt-6-sol";
const supplied = { responseId: "resp_native_fixture", createdAt: 123 };
const final = { type: "message", id: "msg_native_fixture", role: "assistant", status: "completed", phase: "final_answer",
  content: [{ type: "output_text", text: "Read the actual result. 漢🙂", annotations: [] },
    { type: "output_text", text: "Preserve its limits.\n", annotations: [] }] };

function parseSse(wire) {
  const frames = new SseFrameBuffer();
  const events = [];
  let terminal = 0;
  // Exercise real EventSource framing across every UTF-8 byte boundary.
  for (const byte of Buffer.from(wire)) {
    for (const frame of frames.write(Buffer.from([byte]))) {
      const fields = sseFrameFields(frame.bytes, frame.atStreamStart);
      if (fields.data === "[DONE]") { terminal += 1; continue; }
      if (!fields.hasData) continue;
      const event = JSON.parse(fields.data);
      assert.equal(fields.eventName, event.type);
      events.push(event);
    }
  }
  assert.equal(frames.pendingBytes, 0);
  assert.equal(terminal, 1);
  return events;
}

async function throughParsers(wire, contentType) {
  const usage = new ResponseUsageTransform(contentType);
  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  await pipeline(Readable.from([...Buffer.from(wire)].map(byte => Buffer.from([byte]))),
    new NamespaceToolCallTransform([], contentType), new MessagePhaseTransform(), usage, sink);
  return { wire: Buffer.concat(chunks).toString("utf8"), usage };
}

test("JSON framing retains exact native tool identity, literal argument/input strings and unknown usage", async () => {
  const items = [
    { type: "function_call", id: "fc_native", call_id: "call_native", name: "read", namespace: "mcp__files", arguments: '{ "path": "literal.txt" }', status: "completed" },
    { type: "custom_tool_call", id: "ctc_native", call_id: "call_custom", name: "exec", namespace: "functions", input: "text('literal `$ 🌙');\n", status: "completed" },
    { type: "tool_search_call", id: "tsc_native", call_id: "call_search", execution: "client", arguments: { query: "calendar create", limit: 1 }, status: "completed" },
    final,
  ];
  const before = structuredClone(items);
  const response = webResponse({ model, stream: false }, items, supplied);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assert.equal(body.id, supplied.responseId);
  assert.equal(body.created_at, supplied.createdAt);
  assert.equal(body.object, "response");
  assert.equal(body.model, model);
  assert.equal(body.status, "completed");
  assert.equal(body.usage, null);
  assert.equal(responseTerminalOutcome(body), "completed");
  assert.deepEqual(body.output, before);
  assert.deepEqual(items, before, "response framing must not mutate caller-owned output");
});

test("actual broker-produced function/custom/search calls survive SSE and existing native relay parsers", async () => {
  const broker = createWebToolBroker();
  const declarations = [
    { type: "namespace", name: "mcp__files", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
    { type: "namespace", name: "other", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
    { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] },
    { type: "tool_search", execution: "client" },
  ];
  const { token, tools } = broker.register({ threadId: "thread", turnId: "turn", tools: declarations });
  const pending = tools.map(tool => broker.invoke(token, { wireName: tool.wireName,
    ...(tool.kind === "custom" ? { input: "text('quoted 🌙');\n" } : { arguments: { query: "actual fixture" } }) }));
  const calls = broker.takeCalls(token);
  const response = webResponse({ model, stream: true }, [...calls, final], supplied);
  const wire = await response.text();
  const parsed = await throughParsers(wire, response.headers.get("content-type"));
  assert.equal(parsed.wire, wire);
  const events = parseSse(parsed.wire);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_event, index) => index));
  assert.deepEqual(events.slice(0, 2).map(event => event.type), ["response.created", "response.in_progress"]);
  assert.ok(events.slice(0, 2).every(event => event.response.id === supplied.responseId && event.response.status === "in_progress" && !event.response.output.length));
  const done = events.filter(event => event.type === "response.output_item.done");
  assert.deepEqual(done.map(event => event.output_index), [0, 1, 2, 3, 4]);
  assert.deepEqual(done.map(event => event.item), [...calls, final]);
  assert.deepEqual(events.at(-1).response.output, [...calls, final]);
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.usage, null);
  assert.equal(parsed.usage.completedResponseObserved(), true);
  assert.deepEqual(parsed.usage.responseOutputObservation(), { complete: true, output: [...calls, final] });
  assert.equal(parsed.usage.reportedTokenUsage(), undefined);
  assert.equal(parsed.usage.tokenUsage(), undefined);

  const outputs = done.slice(0, -1).map(({ item }) => item.type === "tool_search_call"
    ? { type: "tool_search_output", call_id: item.call_id, execution: "client", status: "completed", tools: [] }
    : { type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output", call_id: item.call_id, output: "native result" });
  broker.complete(token, outputs);
  await Promise.all(pending);
  assert.equal(broker.finish(token), true);
});

test("SSE deltas reconstruct each completed native field and final text without changing namespaces", async () => {
  const output = [
    { type: "function_call", id: "fc_one", call_id: "call_one", name: "read", namespace: "one", arguments: '{"path":"漢🙂"}' },
    { type: "custom_tool_call", id: "ctc_two", call_id: "call_two", name: "exec", namespace: "functions", input: "text('🌙');\n" },
    final,
  ];
  const events = parseSse(await webResponse({ model, stream: true }, output, supplied).text());
  for (const [index, item] of output.entries()) {
    const matching = events.filter(event => event.output_index === index);
    const added = matching.find(event => event.type === "response.output_item.added").item;
    const done = matching.find(event => event.type === "response.output_item.done").item;
    assert.equal(added.id, done.id);
    assert.equal(added.namespace, done.namespace);
    assert.equal(added.status, "in_progress");
    assert.equal(done.status, "completed");
    if (item.type !== "message") {
      const custom = item.type === "custom_tool_call";
      const type = custom ? "response.custom_tool_call_input" : "response.function_call_arguments";
      const field = custom ? "input" : "arguments";
      assert.equal(added[field], "");
      assert.equal(matching.filter(event => event.type === `${type}.delta`).map(event => event.delta).join(""), item[field]);
      assert.equal(matching.find(event => event.type === `${type}.done`)[field], item[field]);
      assert.ok(matching.filter(event => event.type.startsWith(type)).every(event => event.item_id === item.id));
    } else {
      assert.equal(added.phase, "final_answer");
      assert.equal(done.phase, "final_answer");
      for (const [contentIndex, part] of item.content.entries()) {
        const content = matching.filter(event => event.content_index === contentIndex);
        assert.equal(content.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""), part.text);
        assert.deepEqual(content.find(event => event.type === "response.content_part.done").part, part);
      }
    }
  }
  const json = await webResponse({ model }, output, supplied).json();
  assert.deepEqual(events.at(-1).response, json);
});

test("missing item identities receive native prefixes and malformed or unfinished output fails before publication", async () => {
  const output = [
    { type: "function_call", call_id: "call_fn", name: "read", arguments: "{}" },
    { type: "custom_tool_call", call_id: "call_custom", name: "patch", input: "raw" },
    { type: "tool_search_call", call_id: "call_search", execution: "client", arguments: { query: "read" } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
  ];
  const body = await webResponse({ model }, output).json();
  assert.match(body.id, /^resp_[a-f0-9]+$/u);
  for (const [index, prefix] of ["fc", "ctc", "tsc", "msg"].entries()) assert.match(body.output[index].id, new RegExp(`^${prefix}_[a-f0-9]+$`, "u"));
  assert.equal(body.output.at(-1).phase, "final_answer");
  assert.deepEqual(body.output.at(-1).content[0].annotations, []);
  const invalid = [[{ ...output[0], arguments: {} }], [{ ...output[1], input: undefined }],
    [{ ...output[2], execution: "server" }], [{ ...output[0], status: "in_progress" }],
    [{ ...output[0], call_id: undefined }], [output[0], { ...output[0] }],
    [{ ...output[0], id: "same" }, { ...output[1], id: "same" }],
    [{ type: "message", role: "user", content: [] }], [{ type: "reasoning", summary: [] }]];
  for (const items of invalid) assert.throws(() => webResponse({ model, stream: true }, items), { code: "invalid_web_response", status: 502 });
});

test("local compaction keeps user/call/result authority, redacts secrets and replays deterministic checkpoints", async () => {
  const input = [
    { role: "user", content: "Inspect only; do not change the fixture." },
    { type: "function_call", name: "read", namespace: "mcp__files", call_id: "call_inspect", arguments: '{"path":"fixture"}' },
    { type: "function_call_output", call_id: "call_inspect", output: '{"exit_code":7,"note":"observed failure","token":"secret-canary"}' },
    { role: "assistant", content: "I claim the deployment succeeded." },
    { role: "user", content: "Preserve the observed failure and investigate its cause." },
  ];
  const before = structuredClone(input);
  const response = webCompactResponse({ model, input, stream: true });
  assert.equal(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assert.equal(body.output.length, 1);
  const item = body.output[0];
  assert.equal(item.type, "compaction");
  assert.match(item.id, /^cmp_[a-f0-9]+$/u);
  const checkpoint = decodeCompaction(item.encrypted_content).checkpoint;
  assert.equal(checkpoint.sources.U001.kind, "user_message");
  assert.equal(checkpoint.sources.U002.excerpt, input.at(-1).content);
  assert.equal(checkpoint.sources.C001.kind, "tool_call");
  assert.equal(checkpoint.sources.R001.kind, "tool_result");
  assert.equal(checkpoint.sources.R001.outcome, "exit_nonzero");
  assert.equal(checkpoint.sources.R001.exit_code, 7);
  assert.ok(!JSON.stringify(checkpoint).includes("secret-canary"));
  assert.ok(!Object.keys(checkpoint.sources).some(source => source.startsWith("A")));
  assert.ok(checkpoint.recent_tail.some(source => source.kind === "assistant_message"));
  assert.ok(checkpoint.orientation.unknowns.some(value => value.includes("omitted")));
  assert.equal((await webCompactResponse({ model, input }).json()).output[0].encrypted_content, item.encrypted_content);
  const replay = prepareCompaction([item]);
  assert.equal(replay.sources.get("R001").outcome, "exit_nonzero");
  assert.deepEqual(input, before);
});

test("compaction stays bounded across repeated replay and refuses unreadable opaque checkpoints", async () => {
  const input = [{ role: "user", content: "Preserve the request and current evidence." }];
  for (let index = 0; index < 200; index += 1) input.push(
    { type: "function_call", call_id: `call_${index}`, name: "inspect", arguments: "{}" },
    { type: "function_call_output", call_id: `call_${index}`, output: `fixture-${index} ` + "漢🙂".repeat(600) });
  input.push({ role: "user", content: "Keep the latest observed fixture too." });
  const item = (await webCompactResponse({ model, input }).json()).output[0];
  const checkpoint = decodeCompaction(item.encrypted_content).checkpoint;
  assert.ok(Buffer.from(item.encrypted_content.slice(5), "base64").length <= 96 * 1024);
  assert.ok(Object.keys(checkpoint.sources).length <= 32);
  assert.ok(checkpoint.source_refs.requirements.length > 0);
  assert.ok(Object.values(checkpoint.sources).some(source => source.excerpt.includes("fixture-199")));
  assert.ok(Object.values(checkpoint.sources).some(source => source.truncated));
  const again = (await webCompactResponse({ model, input: [item, { role: "user", content: "Continue inspection." }] }).json()).output[0];
  const decoded = decodeCompaction(again.encrypted_content).checkpoint;
  assert.ok(Object.values(decoded.sources).some(source => source.excerpt === "Continue inspection."));
  assert.ok(decoded.counters.U > checkpoint.counters.U);
  for (const encrypted_content of ["native-opaque-envelope", "kcr2:broken"]) {
    assert.throws(() => webCompactResponse({ model, input: [{ type: "compaction", encrypted_content }] }), { code: "encrypted_v2_unsupported", status: 422 });
  }
  assert.throws(() => webCompactResponse({ model, input: "cannot silently discard this input" }), { code: "invalid_web_compaction", status: 400 });
});

test("compaction preserves the undelivered native tail beside its readable checkpoint", async () => {
  const retainedTail = [
    { type: "function_call", namespace: "mcp__fixture", name: "read", call_id: "pending_read", arguments: '{"path":"fixture"}' },
    { type: "function_call_output", call_id: "pending_read", output: '{"exit_code":0,"text":"漢🙂\\nactual result"}' },
    { type: "custom_tool_call", namespace: "fixture", name: "check", call_id: "pending_check", input: "exact\ninput" },
    { type: "custom_tool_call_output", call_id: "pending_check", output: "actual\nresult" },
    { role: "user", content: [{ type: "input_text", text: "Continue using those results." }] },
  ];
  const input = [{ role: "user", content: "Already delivered history." }, ...retainedTail];
  const before = structuredClone(input);
  const { output } = await webCompactResponse({ model, input }, { retainedTail }).json();
  assert.ok(decodeCompaction(output[0].encrypted_content));
  assert.deepEqual(output.slice(1), retainedTail);
  assert.deepEqual(input, before);
});

test("native V2 compaction emits one completed item with an in-band exact tail and survives native ID stripping", async () => {
  const retainedTail = [{ role: "user", content: "Pending native user" },
    { type: "function_call", name: "read", call_id: "pending_native", arguments: '{ "path": "literal.txt" }' },
    { type: "function_call_output", call_id: "pending_native", output: "Actual pending result" }];
  for (const stream of [true, false]) {
    const response = webCompactResponse({ model, stream, input: [{ role: "user", content: "History" }] }, { compactV2: true, retainedTail });
    let output;
    if (stream) {
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const events = parseSse(await response.text());
      output = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
      assert.equal(events.at(-1).type, "response.completed");
      assert.deepEqual(events.at(-1).response.output, output);
    } else {
      const body = await response.json();
      assert.equal(body.object, "response"); assert.equal(body.status, "completed"); output = body.output;
    }
    assert.equal(output.length, 1); assert.equal(output[0].type, "compaction");
    const nativeRetainedItem = { type: "compaction", encrypted_content: output[0].encrypted_content };
    const checkpoint = decodeCompaction(nativeRetainedItem.encrypted_content).checkpoint;
    assert.deepEqual(checkpoint.retained_tail, retainedTail);
    assert.equal(checkpoint.retained_tail_id, output[0].id);
  }
});
