import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  ZaiResponsesCompatTransform,
  zaiResponsesCompatTransform,
} from "../src/zai-responses-compat.mjs";

async function transformed(chunks) {
  const stream = new ZaiResponsesCompatTransform();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output += chunk; });
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await once(stream, "end");
  return output;
}

function block(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function dataEvents(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((part) => {
    const line = part.split(/\r?\n/).find((value) => value.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : undefined;
  }).filter(Boolean);
}

test("repairs the live LiteLLM reasoning-to-message Responses envelope", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, model: "zai-coding-glm-5-3", item: { id: "rs_1", type: "reasoning", status: "in_progress", summary: [] } }),
    block({ type: "response.output_item.done", output_index: 0, sequence_number: 6, model: "zai-coding-glm-5-3", item: { id: "rs_1", type: "reasoning", summary: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", model: "zai-coding-glm-5-3", delta: "HELLO" }),
    block({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_1", model: "zai-coding-glm-5-3", text: "HELLO" }),
    block({ type: "response.content_part.done", output_index: 0, content_index: 0, item_id: "msg_1", model: "zai-coding-glm-5-3", part: { type: "reasoning_text", reasoning: "private reasoning" } }),
    block({ type: "response.output_item.done", output_index: 0, sequence_number: 1, model: "zai-coding-glm-5-3", item: { id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "HELLO", annotations: [] }] } }),
    block({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } }),
  ].join("");

  const output = await transformed([input.slice(0, 157), input.slice(157)]);
  const events = dataEvents(output);
  const deltaIndex = events.findIndex((event) => event.type === "response.output_text.delta");
  assert.ok(deltaIndex >= 2);
  assert.equal(events[deltaIndex - 2].type, "response.output_item.added");
  assert.equal(events[deltaIndex - 2].item.type, "message");
  assert.equal(events[deltaIndex - 2].item.id, "msg_1");
  assert.equal(events[deltaIndex - 2].output_index, 1);
  assert.equal(events[deltaIndex - 1].type, "response.content_part.added");
  assert.equal(events[deltaIndex - 1].part.type, "output_text");
  assert.equal(events[deltaIndex].output_index, 1);

  const reasoningDone = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "reasoning");
  const textDone = events.find((event) => event.type === "response.output_text.done");
  const partDone = events.find((event) => event.type === "response.content_part.done");
  const messageDone = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");
  assert.equal(reasoningDone.item.id, "rs_1");
  assert.equal(messageDone.item.id, "msg_1");
  assert.equal(textDone.output_index, 1);
  assert.equal(partDone.output_index, 1);
  assert.deepEqual(partDone.part, { type: "output_text", text: "HELLO", annotations: [] });
  assert.equal(messageDone.output_index, 1);
  assert.ok(!output.includes("private reasoning"));
});

test("leaves an already valid message stream byte-identical", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_ok", type: "message", status: "in_progress", role: "assistant", content: [] } }),
    block({ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_ok", part: { type: "output_text", text: "", annotations: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_ok", delta: "OK" }),
  ].join("");
  assert.equal(await transformed([input]), input);
});

test("closes GLM assistant text before relaying an overlapping tool call", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", status: "in_progress", role: "assistant", content: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg", delta: "Checking." }),
    block({ type: "response.output_item.added", output_index: 1, item: { id: "call", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" } }),
    block({ type: "response.function_call_arguments.done", output_index: 1, item_id: "call", call_id: "call_1", name: "lookup", arguments: "{}" }),
    block({ type: "response.output_item.done", output_index: 1, item: { id: "call", type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" } }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Checking.", annotations: [] }] } }),
    block({ type: "response.completed", response: { id: "resp", status: "completed" } }),
  ].join("");

  const events = dataEvents(await transformed([input.slice(0, 211), input.slice(211)]));
  assert.deepEqual(events.map((event) => `${event.type}:${event.output_index ?? "-"}`), [
    "response.output_item.added:0",
    "response.output_text.delta:0",
    "response.output_item.done:0",
    "response.output_item.added:1",
    "response.function_call_arguments.done:1",
    "response.output_item.done:1",
    "response.completed:-",
  ]);
  assert.equal(events[4].arguments, "{}");
  assert.equal(events[5].item.name, "lookup");
});

test("compatibility factory is scoped to proven malformed Responses routes", () => {
  assert.ok(
    zaiResponsesCompatTransform(
      "openrouter",
      "text/event-stream",
      "openrouter/glm-5.3-flash-streamlake",
    ),
  );
  assert.ok(
    zaiResponsesCompatTransform(
      "openrouter",
      "text/event-stream",
      "openrouter/glm-5.3-flash-together",
    ),
  );
  assert.equal(zaiResponsesCompatTransform("openrouter", "text/event-stream"), undefined);
  assert.equal(
    zaiResponsesCompatTransform("openrouter", "text/event-stream", "openrouter/hy4-preview"),
    undefined,
  );
  assert.equal(zaiResponsesCompatTransform("openai", "text/event-stream"), undefined);
  assert.equal(
    zaiResponsesCompatTransform(
      "openrouter",
      "application/json",
      "openrouter/glm-5.3-flash-streamlake",
    ),
    undefined,
  );
});

test("repairs a message-only LiteLLM stream without shifting its zero output index", async () => {
  const input = [
    block({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_only", delta: "OK" }),
    block({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_only", text: "OK" }),
    block({ type: "response.output_item.done", output_index: 0, item: { id: "msg_only", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] } }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  assert.deepEqual(events.slice(0, 3).map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
  ]);
  assert.ok(events.every((event) => !Number.isInteger(event.output_index) || event.output_index === 0));
});

test("repairs a message-only close and never relays reasoning content", async () => {
  const input = block({
    type: "response.output_item.done",
    output_index: 0,
    item: {
      id: "msg_done",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "reasoning_text", reasoning: "private reasoning" }],
    },
  });
  const output = dataEvents(await transformed([input]));
  assert.deepEqual(output.slice(0, 2).map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
  ]);
  const done = output.at(-1);
  assert.equal(done.type, "response.output_item.done");
  assert.equal(done.output_index, 0);
  assert.deepEqual(done.item.content, [{ type: "output_text", text: "", annotations: [] }]);
  assert.ok(!JSON.stringify(output).includes("private reasoning"));
});

test("starts a new repaired message when a later delta changes item id", async () => {
  const input = [
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_2", delta: "second" }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  const delta = events.find((event) => event.type === "response.output_text.delta");
  assert.equal(delta.output_index, 1);
  assert.equal(events.filter((event) => event.type === "response.output_item.added").at(-1).item.id, "msg_2");
});

test("repairs a content-part close when LiteLLM omitted the whole message envelope", async () => {
  const input = block({
    type: "response.content_part.done",
    output_index: 0,
    item_id: "msg_part",
    content_index: 0,
    part: { type: "reasoning_text", reasoning: "private reasoning" },
  });
  const events = dataEvents(await transformed([input]));
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
  ]);
  assert.deepEqual(events.at(-1).part, { type: "output_text", text: "", annotations: [] });
  assert.ok(!JSON.stringify(events).includes("private reasoning"));
});

test("injects only the missing item for a partial message envelope", async () => {
  const input = [
    block({
      type: "response.content_part.added",
      output_index: 0,
      item_id: "msg_part",
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg_part", delta: "ok" }),
  ].join("");
  const events = dataEvents(await transformed([input]));
  assert.deepEqual(events.map((event) => event.type), [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
  ]);
});

test("preserves CRLF framing while repairing the malformed message envelope", async () => {
  const input = [
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "rs", type: "reasoning" } })}\r\n\r\n`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg", delta: "X" })}\r\n\r\n`,
  ].join("");
  const output = await transformed([input]);
  assert.ok(output.includes("\r\n\r\n"));
  assert.equal(output.replace(/\r\n\r\n/g, "").includes("\n\n"), false);
});

test("preserves unparsed SSE blocks and flushes an overlapping item before DONE", async () => {
  const open = block({ type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", content: [] } });
  const held = block({ type: "response.output_item.added", output_index: 1, item: { id: "call", type: "function_call", name: "lookup", arguments: "" } });
  const malformed = ": keepalive\r\ndata: {broken\r\n\r\n";
  const noData = "event: keepalive\n\n";
  const nullData = "data: null\n\n";
  const done = "data: [DONE]";
  const input = `${open}${held}${malformed}${noData}${nullData}${done}`;
  assert.equal(await transformed([input.slice(0, 83), input.slice(83)]), `${open}${malformed}${noData}${nullData}${held}${done}`);
});

test("retains a secondary DONE line when a rewritten event is terminal", async () => {
  const open = block({ type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", content: [] } });
  const held = block({ type: "response.output_item.added", output_index: 1, item: { id: "call", type: "function_call", name: "lookup", arguments: "" } });
  const close = { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", content: [{ type: "reasoning_text", reasoning: "private" }] } };
  const terminal = `event: response.output_item.done\r\ndata: ${JSON.stringify(close)}\r\ndata: [DONE]\r\n\r\n`;
  const repaired = { ...close, item: { ...close.item, content: [{ type: "output_text", text: "", annotations: [] }] } };
  assert.equal(await transformed([`${open}${held}${terminal}`]), `${open}${held}event: response.output_item.done\r\ndata: ${JSON.stringify(repaired)}\r\ndata: [DONE]\r\n\r\n`);
});

test("repairs split UTF-8 text and an unterminated final message close", async () => {
  const event = { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg", delta: "Hello 🌍" };
  const done = { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", content: [{ type: "output_text", text: event.delta, annotations: [] }] } };
  const input = Buffer.from(`${block(event)}data: ${JSON.stringify(done)}`);
  const split = input.indexOf(Buffer.from("🌍")) + 2;
  const output = await transformed([input.subarray(0, split), input.subarray(split)]);
  const events = dataEvents(output);
  assert.equal(events.find((entry) => entry.type === "response.output_text.delta").delta, "Hello 🌍");
  assert.deepEqual(events.at(-1), done);
  assert.equal(output.endsWith("\n\n"), false);
});

test("preserves mixed SSE delimiters across every short chunk boundary", async () => {
  const input = Buffer.from([
    "\n\n: heartbeat\r\n\r\n",
    block({ type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", content: [] } }).replaceAll("\n", "\r\n"),
    block({ type: "response.output_text.delta", output_index: 0, item_id: "msg", delta: "🌍 42" }),
    "data: {malformed\r\n\r\n",
    block({ type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", content: [{ type: "output_text", text: "🌍 42" }] } }),
    "data: [DONE]\r\n\r\nevent: keepalive",
  ].join(""));
  for (let size = 1; size <= 11; size += 1) {
    const chunks = [];
    for (let offset = 0; offset < input.length; offset += size) {
      chunks.push(input.subarray(offset, offset + size));
    }
    assert.equal(await transformed(chunks), input.toString("utf8"), `chunk size ${size}`);
  }
});

test("preserves a long fragmented terminal event and the following block", async () => {
  const input = Buffer.from(block({
    type: "response.completed",
    response: { id: "resp", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(256 * 1024) }] }] },
  }).replaceAll("\n", "\r\n") + ": done\n\n");
  const chunks = [];
  for (let offset = 0; offset < input.length; offset += 64) {
    chunks.push(input.subarray(offset, offset + 64));
  }
  assert.equal(await transformed(chunks), input.toString("utf8"));
});
