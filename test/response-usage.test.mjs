import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  ResponseUsageTransform,
  estimateInputTokens,
  mergeTokenUsage,
  reportedTokenUsageFromPayload,
  tokenUsageFromPayload,
} from "../src/response-usage.mjs";

async function run(chunks, options = {}, contentType = "text/event-stream") {
  const transform = new ResponseUsageTransform(contentType, options);
  const output = [];
  transform.on("data", (chunk) => output.push(chunk));
  await new Promise((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
    Readable.from(chunks).pipe(transform);
  });
  return { body: Buffer.concat(output.map((chunk) => Buffer.from(chunk))), transform };
}

function* fragmented(bytes, size = 64) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

test("usage edits preserve ambiguous identities, exact decimals and invalid bytes", async () => {
  for (const raw of [
    '{"usage":{"input_tokens":0},"name":"first","na\\u006de":"second"}',
    '{"usage":{"input_tokens":0},"value":0.123456789012345678901}',
    '{"usage":{"input_tokens":0},"value":9007199254740993}',
  ]) for (const stream of [false, true]) {
    const wire = Buffer.from(stream ? `data: ${raw}\n\n` : raw);
    const {body, transform} = await run(fragmented(wire, 1), {estimatedInputTokens:1234}, stream ? "text/event-stream" : "application/json");
    assert.deepEqual(body, wire);
    assert.equal(transform.substitutedInputTokens(), undefined);
    assert.equal(transform.completedResponseObserved(), false);
  }
  const invalid = Buffer.concat([Buffer.from('{"usage":{"input_tokens":0},"text":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.deepEqual((await run([invalid], {estimatedInputTokens:1234}, "application/json")).body, invalid);
  const valid = 'data: {"type":"response.completed","usage":{"input_tokens":0,"output_tokens":2}}\n\n';
  await assert.rejects(run([valid, 'data: {"type":"response.completed","value":1e-999}\n\n'], {estimatedInputTokens:1234}), /unsafe after substitution/);
  // An unsafe first event disables editing; following partial bytes retain order.
  const chunks = ['data: {broken}\n\ndata: {"usage":', '{"input_tokens":0}}\n\n'];
  assert.equal((await run(chunks, {estimatedInputTokens:1234})).body.toString(), chunks.join(""));
});

test("terminal observation requires complete consistent events and accepts multiline data", async () => {
  const event = {type:"response.completed",response:{status:"completed",output:[],usage:{input_tokens:12,output_tokens:3}}};
  for (const sep of ["\n", "\r", "\r\n"]) for (const label of ["", `event: message${sep}`, `event: wrong${sep}event: response.completed${sep}`]) {
    const data = JSON.stringify(event,null,2).split("\n").map(line=>`data: ${line}`).join(sep);
    const wire = `${label}${data}${sep}${sep}`;
    const {body,transform} = await run(fragmented(Buffer.from(wire),1));
    assert.equal(body.toString(),wire);
    assert.equal(transform.completedResponseObserved(),true);
    assert.deepEqual(transform.tokenUsage(),{inputTokens:12,outputTokens:3,totalTokens:15});
    const rewritten = await run(fragmented(Buffer.from(wire.replace('"input_tokens": 12','"input_tokens": 0')),1),{estimatedInputTokens:1234});
    assert.equal(rewritten.transform.substitutedInputTokens(),1234);
  }
  for (const tail of [
    `data: ${JSON.stringify(event)}`, `data: ${JSON.stringify(event)}\n`,
    `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`,
    `data: ${JSON.stringify({...event,response:{...event.response,status:"incomplete"}})}\n\n`,
    'data: {"type":"response.failed","type":"response.completed"}\n\n',
    'data: {"type":"response.completed","response":{"status":"in_progress"}}\n\n',
  ]) {
    const {transform} = await run([tail]);
    assert.equal(transform.completedResponseObserved(),false,tail);
    assert.deepEqual(transform.responseOutputObservation(),{complete:false,output:[]});
  }
  const observer=new ResponseUsageTransform("text/event-stream"); observer.on("data",()=>{});
  observer.write(`data: ${JSON.stringify(event)}\n`);
  assert.equal(observer.completedResponseObserved(),false);
  observer.write("\n");
  assert.equal(observer.completedResponseObserved(),true);
  observer.destroy();
  const failed = await run(['data: {"type":"response.failed"}\n\n',`data: ${JSON.stringify(event)}\n\n`]);
  assert.equal(failed.transform.completedResponseObserved(),false);
});

test("missing counters stay unknown and partial retry sums keep their coverage", () => {
  assert.deepEqual(tokenUsageFromPayload({usage:{output_tokens:3}}),{outputTokens:3});
  assert.deepEqual(tokenUsageFromPayload({usage:{input_tokens:12}}),{inputTokens:12});
  assert.deepEqual(tokenUsageFromPayload({usage:{input_tokens:0,output_tokens:0}}),{inputTokens:0,outputTokens:0,totalTokens:0});
  for (const absent of [undefined,null,"invalid",1.5]) {
    assert.deepEqual(tokenUsageFromPayload({usage:{input_tokens:absent,output_tokens:3}}),{outputTokens:3});
  }
  const partial=mergeTokenUsage({outputTokens:3},{inputTokens:12,outputTokens:1,totalTokens:13});
  assert.deepEqual(partial,{inputTokens:12,inputTokensComplete:false,outputTokens:4,totalTokens:13,totalTokensComplete:false,usageComplete:false});
  assert.equal(mergeTokenUsage(partial,{inputTokens:1,outputTokens:0,totalTokens:1}).inputTokensComplete,false);
});

test("only opaque reasoning input is excluded from model-visible request estimates", () => {
  const visible="x".repeat(12000);
  for (const payload of [
    {tools:[{parameters:{const:{encrypted_content:visible}}}]},
    {input:[{type:"function_call_output",output:{encrypted_content:visible}}]},
    {input:[{type:"message",content:[{type:"input_text",text:visible}]}]},
    {input:[{type:"unknown",encrypted_content:visible}]},
  ]) {
    const body=JSON.stringify(payload), expected=Math.ceil(Buffer.byteLength(body)/3.3);
    assert.equal(estimateInputTokens(body),expected);
    assert.equal(estimateInputTokens(body,{payload}),expected);
  }
  const payload={input:[{type:"reasoning",encrypted_content:visible},{type:"message",content:"é\\\"".repeat(3000)}]};
  const body=JSON.stringify(payload),expected=Math.ceil((Buffer.byteLength(body)-Buffer.byteLength(JSON.stringify(visible)))/3.3);
  assert.equal(estimateInputTokens(body),expected);
  assert.equal(estimateInputTokens(body,{payload}),expected);
  assert.equal(estimateInputTokens(body,{payload,contextWindow:1000}),1000);
  assert.equal(estimateInputTokens(JSON.stringify({input:[{type:"reasoning",encrypted_content:visible}]})),undefined);
  const ambiguous=`{"input":[{"type":"message","type":"reasoning","encrypted_content":"${visible}"}]}`;
  assert.equal(estimateInputTokens(ambiguous),Math.ceil(Buffer.byteLength(ambiguous)/3.3));
});

test("usage and produced tool output survive BOM and every SSE line ending", async () => {
  const tool = { type: "function_call", id: "fc_framing", call_id: "call_framing", name: "inspect", arguments: "{}" };
  const completed = { type: "response.completed", response: { id: "resp_framing", status: "completed", output: [],
    usage: { input_tokens: 0, output_tokens: 3, total_tokens: 3 } } };
  for (const [line, blank] of [["\n", "\n"], ["\r\n", "\r\n"], ["\n", "\r\n"], ["\r", "\r"]]) {
    const encode = event => `data: ${JSON.stringify(event)}${line}${blank}`;
    for (const bom of ["", "\uFEFF"]) for (const rewrite of [false, true]) {
      const prefix = bom + encode({ type: "response.output_item.done", item: tool });
      const wire = Buffer.from(prefix + encode(completed));
      for (const chunks of [[wire], fragmented(wire, 1)]) {
        const { body, transform } = await run(chunks, rewrite ? { estimatedInputTokens: 42 } : {});
        const expected = rewrite ? Buffer.from(prefix + encode({ ...completed, response: { ...completed.response,
          usage: { input_tokens: 42, output_tokens: 3, total_tokens: 45 } } })) : wire;
        assert.deepEqual(body, expected);
        assert.deepEqual(transform.reportedTokenUsage(), { inputTokens: 0, outputTokens: 3 });
        assert.equal(transform.completedResponseObserved(), true);
        assert.deepEqual(transform.responseOutputObservation(), { complete: true, output: [tool] });
      }
    }
  }
});

for (const mode of ["observe", "rewrite"]) {
test(`fragmented large usage ${mode} retains observations with linear capture work`, async () => {
  const payload = {
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(1024 * 1024) }] }],
      usage: { input_tokens: 0, output_tokens: 10, total_tokens: 10 },
    },
  };
  const wire = Buffer.from(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  const concat = Buffer.concat;
  const byteLength = Buffer.byteLength;
  let copied = 0;
  let measured = 0;
  Buffer.concat = (parts, total) => {
    copied += total ?? parts.reduce((bytes, part) => bytes + part.length, 0);
    return concat(parts, total);
  };
  Buffer.byteLength = (value, ...args) => {
    if (typeof value === "string") measured += value.length;
    return byteLength(value, ...args);
  };
  let result;
  try { result = await run(fragmented(wire), mode === "rewrite" ? { estimatedInputTokens: 1_000 } : {}); }
  finally { Buffer.concat = concat; Buffer.byteLength = byteLength; }
  assert.ok(copied <= wire.length * 4, "fragmentation must not repeatedly copy the accumulated prefix");
  assert.ok(measured <= wire.length * 4, "fragmentation must not repeatedly measure the accumulated prefix");
  const expected = {
    ...payload,
    response: { ...payload.response, usage: { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010 } },
  };
  if (mode === "rewrite") assert.equal(result.body.toString("utf8"), `data: ${JSON.stringify(expected)}\r\n\r\n`);
  else assert.deepEqual(result.body, wire);
  assert.deepEqual(result.transform.reportedTokenUsage(), { inputTokens: 0, outputTokens: 10 });
  assert.equal(result.transform.substitutedInputTokens(), mode === "rewrite" ? 1_000 : undefined);
  assert.equal(result.transform.completedResponseObserved(), true);
  assert.deepEqual(result.transform.providerResponseObservation(), { outcome: "completed" });
  assert.deepEqual(result.transform.responseOutputObservation(), { complete: true, output: payload.response.output });
});
}

test("observation requires valid UTF-8 and complete event dispatch at byte boundaries", async () => {
  const prefix = Buffer.from('data: {"type":"response.output_text.delta","delta":"');
  const suffix = Buffer.from('","usage":{"input_tokens":7}}');
  for (const value of [Buffer.from("é😀"), Buffer.from([0xff])]) {
    const content = Buffer.concat([prefix, value, suffix]);
    const decodedBytes = Buffer.byteLength(content.toString("utf8"));
    for (const ending of [Buffer.from("\r\n\r\n"), Buffer.from("\r\n"), Buffer.alloc(0)]) {
      const wire = Buffer.concat([content, ending]);
      for (const chunks of [[wire], fragmented(wire, 1)]) {
        const { body, transform } = await run(chunks, { maxPendingBytes: decodedBytes });
        assert.deepEqual(body, wire);
        assert.deepEqual(transform.reportedTokenUsage(), value[0] !== 0xff && ending.length === 4 ? { inputTokens: 7 } : undefined);
        assert.equal(typeof transform.firstTokenAt(), value[0] !== 0xff && ending.length ? "number" : "undefined");
      }
      const oversized = await run(fragmented(wire, 1), { maxPendingBytes: decodedBytes - 1 });
      assert.deepEqual(oversized.body, wire);
      assert.equal(oversized.transform.reportedTokenUsage(), undefined);
    }
  }
});

test("observation forwards incomplete chunks immediately and records first-token time at the line", async () => {
  const stage = new ResponseUsageTransform("text/event-stream");
  const chunks = [];
  stage.on("data", (chunk) => chunks.push(chunk));
  stage.write(Buffer.from('data: {"type":"response.output_text.delta",'));
  assert.equal(chunks.length, 1);
  assert.equal(stage.firstTokenAt(), undefined);
  stage.write(Buffer.from('"delta":"ok"}\n'));
  assert.equal(chunks.length, 2);
  assert.equal(typeof stage.firstTokenAt(), "number");
  stage.destroy();
});

test("fragmented JSON usage capture preserves unchanged bytes and zero-only substitution", async () => {
  for (const input of [0, 12, null]) {
    const wire = Buffer.from(` { "status": "completed", "usage": {"input_tokens":${input},"output_tokens":3}, "text":"${"é".repeat(1024)}" } `);
    const { body, transform } = await run(fragmented(wire, 3), { estimatedInputTokens: 123 }, "application/json");
    if (input === 0) {
      assert.equal(JSON.parse(body).usage.input_tokens, 123);
      assert.equal(JSON.parse(body).usage.total_tokens, 126);
      assert.deepEqual(transform.reportedTokenUsage(), { inputTokens: 0, outputTokens: 3 });
    } else {
      assert.deepEqual(body, wire, "nonzero or missing usage does not change the representation");
      assert.equal(transform.substitutedInputTokens(), undefined);
    }
  }
  const invalid = Buffer.from([0xff, 0x20, 0x7b, 0x7d]);
  assert.deepEqual((await run(fragmented(invalid, 1), { estimatedInputTokens: 123 }, "application/json")).body, invalid);
});

test("oversized JSON usage capture releases exact bytes and stops observation", async () => {
  const wire = Buffer.from(JSON.stringify({
    padding: "x".repeat(8 * 1024 * 1024), usage: { input_tokens: 0, output_tokens: 1 },
  }));
  for (const options of [{}, { estimatedInputTokens: 123 }]) {
    const { body, transform } = await run(fragmented(wire, 4096), options, "application/json");
    assert.deepEqual(body, wire);
    assert.equal(transform.reportedTokenUsage(), undefined);
    assert.equal(transform.substitutedInputTokens(), undefined);
  }
});

test("JSON capture does not trust invalid UTF-8 even inside the raw byte limit", async () => {
  const prefix = Buffer.from('{"padding":"');
  const suffix = Buffer.from('","usage":{"input_tokens":7}}');
  const padding = Buffer.alloc(8 * 1024 * 1024 - prefix.length - suffix.length, 0x78);
  padding[0] = 0xff;
  const wire = Buffer.concat([prefix, padding, suffix]);
  assert.equal(Buffer.byteLength(wire.toString("utf8")), wire.length + 2);
  for (const options of [{}, { estimatedInputTokens: 123 }]) {
    const { body, transform } = await run(fragmented(wire, 64 * 1024), options, "application/json");
    assert.deepEqual(body, wire);
    assert.equal(transform.reportedTokenUsage(), undefined);
  }
});

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

test("usage observation exposes completed client tool output without treating partial streams as complete", async () => {
  const item = { type: "tool_search_call", id: "tool-search-1", arguments: {} };
  const completed = { id: "resp_tools", status: "completed", output: [item] };
  const { transform } = await run([
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
  ]);
  assert.deepEqual(transform.responseOutputObservation(), {
    complete: true,
    output: [item],
  });

  const partial = await run([
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
  ]);
  assert.deepEqual(partial.transform.responseOutputObservation(), {
    complete: false,
    output: [],
  });
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
    inputTokensComplete: false,
    outputTokens: 100,
    outputTokensComplete: false,
    totalTokens: 12_100,
    totalTokensComplete: false,
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
