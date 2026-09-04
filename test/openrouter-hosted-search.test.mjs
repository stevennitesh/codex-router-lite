import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  OpenRouterHostedSearchTransform,
  prepareOpenRouterHostedSearchRequest,
  restoreOpenRouterHostedSearchPayload,
} from "../src/openrouter-hosted-search.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";

const route = MODEL_BY_SLUG.get("openrouter/glm-5.3-flash");

async function transformBody(chunks, contentType) {
  const transform = new OpenRouterHostedSearchTransform(contentType);
  const output = [];
  transform.on("data", (chunk) => output.push(chunk));
  await new Promise((resolve, reject) => {
    transform.once("end", resolve);
    transform.once("error", reject);
    Readable.from(chunks).pipe(transform);
  });
  return Buffer.concat(output).toString("utf8");
}

test("hosted-search request maps only native search surfaces to the bounded OpenRouter tool", () => {
  const searchHistory = {
    type: "web_search_call",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "current docs", sources: [{ url: "https://example.com" }] },
  };
  const ordinaryFunction = { type: "function", name: "web_search", parameters: { type: "object" } };
  const payload = prepareOpenRouterHostedSearchRequest({
    model: route.gatewayModel,
    input: [searchHistory, { type: "message", role: "user", content: "Refresh it." }],
    tools: [
      { type: "web_search", search_context_size: "medium" },
      ordinaryFunction,
    ],
    tool_choice: { type: "allowed_tools", tools: [{ type: "web_search" }, ordinaryFunction] },
    include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
    web_search_options: { user_location: { type: "approximate", country: "US" } },
    max_tool_calls: 20,
  }, route);

  assert.deepEqual(payload.tools[0], {
    type: "openrouter:web_search",
    parameters: {
      engine: "exa",
      mode: "fast",
      max_results: 5,
      max_total_results: 15,
      max_uses: 3,
      search_context_size: "medium",
      user_location: { type: "approximate", country: "US" },
    },
  });
  assert.strictEqual(payload.tools[1], ordinaryFunction);
  assert.equal(payload.input[0].type, "openrouter:web_search");
  assert.deepEqual(payload.input[0].action, searchHistory.action);
  assert.equal(payload.tool_choice.tools[0].type, "openrouter:web_search");
  assert.strictEqual(payload.tool_choice.tools[1], ordinaryFunction);
  assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
  assert.equal(payload.web_search_options, undefined);
  assert.equal(payload.max_tool_calls, 3);
});

test("hosted-search response restores non-streaming calls without changing citations", async () => {
  const payload = {
    status: "completed",
    output: [
      {
        type: "openrouter:web_search",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "current docs", sources: [{ url: "https://example.com" }] },
      },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: "Current.",
          annotations: [{ type: "url_citation", url: "https://example.com" }],
        }],
      },
    ],
  };
  const restored = JSON.parse(await transformBody(
    [Buffer.from(JSON.stringify(payload))],
    "application/json",
  ));
  assert.equal(restored.output[0].type, "web_search_call");
  assert.deepEqual(restored.output[0].action, payload.output[0].action);
  assert.deepEqual(restored.output[1], payload.output[1]);
});

test("hosted-search response restores split SSE item and terminal events losslessly", async () => {
  const item = {
    type: "openrouter:web_search",
    id: "ws_1",
    status: "completed",
    action: { type: "search", query: "current docs", sources: [{ url: "https://example.com" }] },
  };
  const events = [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ];
  const input = `${events.map((event) =>
    `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`;
  const midpoint = Math.floor(input.length / 2);
  const output = await transformBody(
    [Buffer.from(input.slice(0, midpoint)), Buffer.from(input.slice(midpoint))],
    "text/event-stream",
  );
  const restored = output.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(5)));
  assert.equal(restored[0].item.type, "web_search_call");
  assert.equal(restored[1].item.type, "web_search_call");
  assert.equal(restored[2].response.output[0].type, "web_search_call");
  assert.deepEqual(restored[2].response.output[0].action, item.action);
  assert.match(output, /data: \[DONE\]\r\n\r\n$/u);
});

test("hosted-search response leaves unrelated provider payloads byte-identical", async () => {
  const payload = { output: [{ type: "function_call", name: "web_search", arguments: "{}" }] };
  assert.strictEqual(restoreOpenRouterHostedSearchPayload(payload), payload);
  const body = `${JSON.stringify(payload)}\n`;
  assert.equal(await transformBody([Buffer.from(body)], "application/json"), body);
});
