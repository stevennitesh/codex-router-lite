import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  ResponseUsageTransform,
  mergeTokenUsage,
  reportedTokenUsageFromPayload,
  tokenUsageFromPayload,
} from "../src/response-usage.mjs";

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

test("usage observation preserves cache reads and writes without inventing absent counters", async () => {
  const fixtures = [
    [
      { cached_tokens: 8_000, cache_write_tokens: 4_000 },
      { cachedInputTokens: 8_000, cacheWriteTokens: 4_000 },
    ],
    [
      { cached_tokens: 8_000, cache_write_tokens: 0 },
      { cachedInputTokens: 8_000, cacheWriteTokens: 0 },
    ],
    [
      { cached_tokens: 8_000 },
      { cachedInputTokens: 8_000 },
    ],
    [
      { cached_tokens: 8_000, cache_write_tokens: null },
      { cachedInputTokens: 8_000 },
    ],
    [
      { cached_tokens: 8_000, cache_write_tokens: "invalid" },
      { cachedInputTokens: 8_000 },
    ],
  ];
  for (const [details, expectedDetails] of fixtures) {
    const usage = {
      input_tokens: 12_000,
      output_tokens: 100,
      total_tokens: 12_100,
      input_tokens_details: details,
    };
    const expected = {
      inputTokens: 12_000,
      outputTokens: 100,
      totalTokens: 12_100,
      ...expectedDetails,
    };
    assert.deepEqual(tokenUsageFromPayload({ usage }), expected);

    const wire = `data: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n`;
    const { transform } = await run([...wire]);
    assert.deepEqual(transform.tokenUsage(), expected);
  }
});

test("provider attempt observation preserves missing counters and terminal metadata", async () => {
  assert.deepEqual(reportedTokenUsageFromPayload({
    usage: { output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
  }), { cachedInputTokens: 0, outputTokens: 2 });
  assert.equal(reportedTokenUsageFromPayload({
    usage: { input_tokens: "12", output_tokens: 1.5 },
  }), undefined, "invalid provider counter types are not coerced or rounded");
  const wire = `data: ${JSON.stringify({
    type: "response.incomplete",
    response: {
      status: "incomplete",
      model: "gpt-6-astra",
      service_tier: "priority",
      usage: { output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    },
  })}\n\n`;
  const { transform } = await run([wire], { estimatedInputTokens: 1_234 });
  assert.deepEqual(transform.reportedTokenUsage(), { cachedInputTokens: 0, outputTokens: 2 });
  assert.deepEqual(transform.providerResponseObservation(), {
    outcome: "incomplete",
    returnedModel: "gpt-6-astra",
    returnedTier: "priority",
  });
  assert.equal(transform.reportedTokenUsage().inputTokens, undefined,
    "a compaction estimate is not provider-reported input");
});

test("retry usage aggregation reports optional-counter and whole-attempt coverage", () => {
  const first = {
    inputTokens: 12_000,
    outputTokens: 100,
    totalTokens: 12_100,
    cachedInputTokens: 8_000,
    cacheWriteTokens: 4_000,
  };
  const second = {
    inputTokens: 6_000,
    outputTokens: 50,
    totalTokens: 6_050,
    cachedInputTokens: 3_000,
  };
  assert.deepEqual(mergeTokenUsage(first, second), {
    inputTokens: 18_000,
    outputTokens: 150,
    totalTokens: 18_150,
    usageComplete: true,
    cachedInputTokens: 11_000,
    cachedInputTokensComplete: true,
    cacheWriteTokens: 4_000,
    cacheWriteTokensComplete: false,
  });
  assert.deepEqual(mergeTokenUsage(first, undefined), {
    inputTokens: 12_000,
    outputTokens: 100,
    totalTokens: 12_100,
    usageComplete: false,
    cachedInputTokens: 8_000,
    cachedInputTokensComplete: false,
    cacheWriteTokens: 4_000,
    cacheWriteTokensComplete: false,
  });
  assert.equal(mergeTokenUsage(undefined, undefined), undefined);
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
