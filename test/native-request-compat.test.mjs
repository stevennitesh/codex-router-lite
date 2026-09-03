import assert from "node:assert/strict";
import test from "node:test";

import {
  bearerToken,
  callerBroughtNoUpstreamCredential,
  normalizeNativeForSubstitutedCaller,
} from "../src/native-request-compat.mjs";

const CALLER = "caller-secret-0123456789abcdef";
const INTERNAL = "internal-key-0123456789abcdef";

test("router credentials trigger native session substitution", () => {
  const options = { callerKey: CALLER, internalKey: INTERNAL };
  assert.equal(callerBroughtNoUpstreamCredential({}, options), true);
  assert.equal(
    callerBroughtNoUpstreamCredential({ authorization: `Bearer ${CALLER}` }, options),
    true,
  );
  assert.equal(
    callerBroughtNoUpstreamCredential({ authorization: `bearer ${INTERNAL}` }, options),
    true,
  );
  assert.equal(
    callerBroughtNoUpstreamCredential(
      { authorization: "Bearer sk-a-real-upstream-token" },
      options,
    ),
    false,
  );
  assert.equal(
    callerBroughtNoUpstreamCredential({ authorization: "Basic dXNlcjpwYXNz" }, options),
    false,
  );
});

test("substituted native requests use the supported stateless contract", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "hi" }] }];
  const payload = normalizeNativeForSubstitutedCaller({
    model: "gpt-5.6-luna",
    stream: true,
    input,
    temperature: 0.7,
    top_p: 1,
    presence_penalty: 1,
    frequency_penalty: 1,
    max_tokens: 100,
    max_output_tokens: 100,
    metadata: { a: "b" },
    seed: 1,
    user: "someone",
    truncation: "auto",
    reasoning: { effort: "low" },
    tool_choice: "auto",
    parallel_tool_calls: true,
    instructions: "be brief",
  });

  assert.equal(payload.store, false);
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
  for (const key of [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_tokens",
    "max_output_tokens",
    "metadata",
    "seed",
    "user",
    "truncation",
  ]) {
    assert.equal(key in payload, false, `${key} must be stripped`);
  }
  assert.deepEqual(payload.reasoning, { effort: "low" });
  assert.equal(payload.tool_choice, "auto");
  assert.equal(payload.parallel_tool_calls, true);
  assert.equal(payload.instructions, "be brief");
  assert.equal(payload.model, "gpt-5.6-luna");
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.input, input);

  const compact = normalizeNativeForSubstitutedCaller(
    { model: "gpt-5.6-luna", store: true, include: ["reasoning.encrypted_content"] },
    { compact: true },
  );
  assert.equal("store" in compact, false);
  assert.equal("include" in compact, false);
});

test("bearer parsing is linear and rejects invalid schemes", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer\tabc"), "abc");
  assert.equal(bearerToken("  Bearer   abc  "), "abc");
  assert.equal(bearerToken("BearerX"), undefined);
  assert.equal(bearerToken("Bearer"), undefined);
  assert.equal(bearerToken("Bearer    "), undefined);
  assert.equal(bearerToken("Basic abc"), undefined);

  const hostile = `Bearer${" ".repeat(50_000)}`;
  const started = process.hrtime.bigint();
  assert.equal(bearerToken(hostile), undefined);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `parsing took ${elapsedMs.toFixed(1)}ms`);
});
