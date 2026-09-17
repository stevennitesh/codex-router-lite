import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EmptyCompletionGuard, EmptyCompletionTerminalGuard } from "../src/empty-completion-guard.mjs";

test("generic provider SSE errors retain diagnostics instead of triggering empty-success retry", async () => {
  for (const header of ["event: error\n", "event: message\n", ""]) {
    const wire = `${header}data: {"type":"error","code":"provider_error","message":"Synthetic failure"}\n\ndata: [DONE]\n\n`;
    const guard = new EmptyCompletionGuard("text/event-stream");
    let output = "";
    for await (const chunk of Readable.from([...Buffer.from(wire)].map(b => Buffer.from([b])))
      .pipe(guard).pipe(new EmptyCompletionTerminalGuard(guard, "text/event-stream"))) output += chunk;
    assert.equal(guard.isEmpty(), false);
    assert.equal(output, wire);
  }
});

test("explicit unsuccessful Responses terminals survive empty output and DONE without retry", async () => {
  for (const status of ["incomplete", "failed", "completed"]) {
    const event = { type: `response.${status}`, response: { status, output: [],
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      ...(status === "failed" ? { error: { code: "provider_error", message: "Unavailable" } } : {}),
    } };
    const wire = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
    const guard = new EmptyCompletionGuard("text/event-stream");
    let output = "";
    for await (const chunk of Readable.from([...Buffer.from(wire)].map(b => Buffer.from([b])))
      .pipe(guard).pipe(new EmptyCompletionTerminalGuard(guard, "text/event-stream"))) output += chunk;
    if (status === "completed") {
      assert.equal(guard.isEmpty(), true);
      assert.equal(output, "");
    } else {
      assert.equal(guard.isEmpty(), false);
      assert.equal(output, wire);
    }
  }
});
