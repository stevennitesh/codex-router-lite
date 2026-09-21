import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ResponseUsageTransform } from "../src/response-usage.mjs";

async function run(chunks, options = {}) {
  const transform = new ResponseUsageTransform("text/event-stream", options);
  const output = [];
  transform.on("data", (chunk) => output.push(chunk));
  await new Promise((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
    Readable.from(chunks).pipe(transform);
  });
  return { body: Buffer.concat(output.map((chunk) => Buffer.from(chunk))), transform };
}

for (const mode of ["observe", "rewrite"]) {
  test(`usage ${mode} mode releases an oversized pending SSE line byte-for-byte`, async () => {
    const chunks = [Buffer.from("data: "), Buffer.from("x".repeat(20)), Buffer.from([0xff, 0x20]), Buffer.from("tail")];
    const options = {
      maxPendingBytes: 16,
      ...(mode === "rewrite" ? { estimatedInputTokens: 1_234 } : {}),
    };
    const { body, transform } = await run(chunks, options);
    assert.deepEqual(body, Buffer.concat(chunks));
    assert.equal(transform.tokenUsage(), undefined);
    assert.equal(transform.substitutedInputTokens(), undefined);
  });
}

test("usage observation accepts long streams made of bounded lines", async () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n';
  const completed = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n';
  const input = delta.repeat(100) + completed;
  const { body, transform } = await run([input], { maxPendingBytes: 128 });
  assert.equal(body.toString("utf8"), input);
  assert.deepEqual(transform.tokenUsage(), { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});

test("usage rewriting accepts long streams made of bounded lines", async () => {
  const delta = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n';
  const input = delta.repeat(100) + "data: [DONE]\n\n";
  const { body, transform } = await run([input], {
    estimatedInputTokens: 1_234,
    maxPendingBytes: 128,
  });
  assert.equal(body.toString("utf8"), input);
  assert.equal(transform.substitutedInputTokens(), undefined);
});

for (const mode of ["observe", "rewrite"]) {
  test(`usage ${mode} mode treats coalesced and split oversized complete lines identically`, async () => {
    const input = `data: ${JSON.stringify({
      type: "response.completed",
      usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
      padding: "x".repeat(40),
    })}\r\n`;
    const options = {
      maxPendingBytes: 32,
      ...(mode === "rewrite" ? { estimatedInputTokens: 1_234 } : {}),
    };
    for (const chunks of [[input], [...input]]) {
      const { body, transform } = await run(chunks, options);
      assert.equal(body.toString("utf8"), input);
      assert.equal(transform.tokenUsage(), undefined);
      assert.equal(transform.substitutedInputTokens(), undefined);
    }
  });
}

for (const mode of ["observe", "rewrite"]) {
  test(`usage ${mode} mode excludes a split CRLF terminator from the line budget`, async () => {
    const content = "data: [DONE]";
    const input = `${content}\r\n`;
    const { body } = await run([content, "\r", "\n"], {
      ...(mode === "rewrite" ? { estimatedInputTokens: 1_234 } : {}),
      maxPendingBytes: Buffer.byteLength(content),
    });
    assert.equal(body.toString("utf8"), input);
  });
}
