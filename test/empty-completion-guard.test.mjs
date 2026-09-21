import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EmptyCompletionGuard, EmptyCompletionTerminalGuard } from "../src/empty-completion-guard.mjs";

test("paired guards classify named and data-only completions identically across chunk layouts", async () => {
  for (const named of [true, false]) for (const mode of ["empty", "reasoning", "answer"])
    for (const done of [true, false]) for (const layout of ["whole", "events", "bytes"]) {
      const encode = data => `${named ? `event: ${data.type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
      const events = [];
      if (mode === "reasoning") events.push(encode({ type: "response.reasoning_summary_text.delta", delta: "thinking" }));
      events.push(encode({ type: "response.completed", response: { status: "completed", output: mode === "answer" ? [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ] : [] } }));
      if (done) events.push("data: [DONE]\n\n");
      const wire = events.join("");
      const chunks = layout === "whole" ? [wire] : layout === "events" ? events : [...Buffer.from(wire)].map(b => Buffer.from([b]));
      const guard = new EmptyCompletionGuard("text/event-stream");
      let output = "";
      for await (const chunk of Readable.from(chunks).pipe(guard)
        .pipe(new EmptyCompletionTerminalGuard(guard, "text/event-stream"))) output += chunk;
      const label = JSON.stringify({ named, mode, done, layout });
      assert.equal(guard.isEmpty(), mode !== "answer", label);
      assert.equal(output, mode === "answer" ? wire : mode === "reasoning" ? events[0] : "", label);
    }
});

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

test("untyped and malformed data do not establish empty successful completion", async () => {
  for (const data of ['{"response":{"output":[]}}', '{"type":"response.completed",', 'null']) {
    const wire = `data: ${data}\n\n`;
    const guard = new EmptyCompletionGuard("text/event-stream");
    let output = "";
    for await (const chunk of Readable.from([wire]).pipe(guard)
      .pipe(new EmptyCompletionTerminalGuard(guard, "text/event-stream"))) output += chunk;
    assert.equal(guard.isEmpty(), false);
    assert.equal(output, wire);
  }
});

test("explicit unsuccessful Responses terminals survive empty output and DONE without retry", async () => {
  for (const status of ["incomplete", "failed", "completed"]) for (const named of [true, false]) {
    const event = { type: `response.${status}`, response: { status, output: [],
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      ...(status === "failed" ? { error: { code: "provider_error", message: "Unavailable" } } : {}),
    } };
    const wire = `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
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
