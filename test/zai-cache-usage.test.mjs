import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  ZaiCacheUsageCompatTransform,
  zaiCacheUsageTransform,
} from "../src/zai-cache-usage.mjs";

async function transformed(chunks, options) {
  const stream = Readable.from(chunks).pipe(new ZaiCacheUsageCompatTransform(options));
  const output = [];
  for await (const chunk of stream) output.push(chunk);
  return Buffer.concat(output).toString("utf8");
}

test("Z.ai cache usage compatibility survives split SSE chunks and explicit zero", async () => {
  const prefix = 'data: {"usage":{"prompt_tokens":12,"prompt_tokens_details":{"cached_tokens":';
  const output = await transformed([prefix, '0}}}\r\n', 'data: [DONE]\r\n']);
  const usageLine = output.split(/\r?\n/).find((line) => line.includes('"usage"'));
  const payload = JSON.parse(usageLine.slice(5).trim());
  assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(payload.usage.prompt_cache_hit_tokens, 0);
});

test("Z.ai cache compatibility never overwrites a provider-supplied compatibility count", async () => {
  const line = 'data: {"usage":{"prompt_tokens_details":{"cached_tokens":800},"prompt_cache_hit_tokens":700}}\n';
  assert.equal(await transformed([line]), line);
});

test("cache compatibility is installed only for Z.ai event streams", () => {
  assert.ok(zaiCacheUsageTransform("openrouter", "text/event-stream"));
  assert.ok(zaiCacheUsageTransform("openrouter", "text/event-stream; charset=utf-8"));
  assert.equal(zaiCacheUsageTransform("openrouter", "application/json"), undefined);
  assert.equal(zaiCacheUsageTransform("switchyard", "text/event-stream"), undefined);
});

test("non-usage and malformed SSE lines pass through byte-for-byte", async () => {
  const input = 'event: message\r\ndata: {not-json}\r\ndata: [DONE]\r\n';
  assert.equal(await transformed([input]), input);
});

test("an empty usage object is malformed and passes through byte-for-byte", async () => {
  const input = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{}}\n';
  assert.equal(await transformed([input]), input);
});


test("Z.ai choice-bearing terminal usage is normalized to a usage-only chunk", async () => {
  const terminal = {
    id: "chatcmpl-cache",
    model: "glm-5.3",
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 8,
      total_tokens: 1208,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  };
  const output = await transformed([
    `data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
  ]);
  const payloads = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: {") && line.includes('"id"'))
    .map((line) => JSON.parse(line.slice(5).trim()));

  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].choices, terminal.choices);
  assert.equal(payloads[0].usage, undefined);
  assert.deepEqual(payloads[1].choices, []);
  assert.equal(payloads[1].usage.prompt_tokens, 1200);
  assert.equal(payloads[1].usage.completion_tokens, 8);
  assert.equal(payloads[1].usage.prompt_tokens_details.cached_tokens, 800);
  assert.equal(payloads[1].usage.prompt_cache_hit_tokens, 800);
});

test("Z.ai optional rewriting releases an oversized pending line and preserves later bytes", async () => {
  const chunks = ["data: ", "x".repeat(20), " later", "\nnext"];
  assert.equal(await transformed(chunks, { maxPendingBytes: 16 }), chunks.join(""));
});

test("Z.ai rewriting accepts long streams made of bounded lines", async () => {
  const event = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
  const input = event.repeat(100) + "data: [DONE]\n\n";
  assert.equal(await transformed([input], { maxPendingBytes: 64 }), input);
});

test("Z.ai applies the same complete-line limit to coalesced and split input", async () => {
  const input = `data: ${JSON.stringify({
    choices: [{ finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    padding: "x".repeat(40),
  })}\r\n`;
  for (const chunks of [[input], [...input]]) {
    assert.equal(await transformed(chunks, { maxPendingBytes: 32 }), input);
  }
});

test("Z.ai excludes a split CRLF terminator from the line budget", async () => {
  const content = "data: [DONE]";
  assert.equal(
    await transformed([content, "\r", "\n"], { maxPendingBytes: Buffer.byteLength(content) }),
    `${content}\r\n`,
  );
});
