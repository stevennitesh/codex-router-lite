import assert from "node:assert/strict";
import test from "node:test";

import { waitForHealth } from "../src/health-probe.mjs";

test("startup bounds a pending health request by its remaining budget", async t => {
  let clock = 0;
  const windows = [];
  t.mock.method(Date, "now", () => clock);
  t.mock.method(AbortSignal, "timeout", ms => {
    windows.push(ms);
    return new AbortController().signal;
  });
  await assert.rejects(waitForHealth({ label: "fixture", url: "http://127.0.0.1/health", timeoutMs: 75,
    fetchImpl: async () => {
      clock = 75;
      throw new DOMException("deadline", "TimeoutError");
    },
  }), /Timed out.*75 ms/u);
  assert.deepEqual(windows, [75], "startup must not grant a fresh 1000 ms probe at a 75 ms deadline");
});

for (const expectedService of [undefined, "fixture-service"]) {
  for (const shutdown of [false, true]) {
    test(`health body completion rechecks ${shutdown ? "shutdown" : "child exit"}${expectedService ? " after identity validation" : ""}`, async () => {
      const child = { exitCode: null, signalCode: null };
      let shuttingDown = false;
      const finished = () => {
        if (shutdown) shuttingDown = true;
        else child.exitCode = 1;
        return new TextEncoder().encode(JSON.stringify({ service: expectedService }));
      };
      await assert.rejects(waitForHealth({ label: "fixture", url: "http://127.0.0.1/health", child,
        expectedService, isShuttingDown: () => shuttingDown,
        fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
          controller.enqueue(finished()); controller.close();
        } })),
      }), shutdown ? /startup was interrupted/u : /exited before becoming healthy/u);
    });
  }
}

for (const overflow of [false, true]) {
  test(`startup ${overflow ? "health body overflow" : "body deadline"} does not await a stream's cancel acknowledgement`, async () => {
    let acknowledge, canceled = 0, timer;
    const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
    const response = new Response(new ReadableStream({
      start(controller) { if (overflow) controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel() { canceled++; return acknowledgement; },
    }));
    try {
      const operation = waitForHealth({ label: "fixture", url: "http://127.0.0.1/health", timeoutMs: 30,
        expectedService: "fixture-service", fetchImpl: async () => response,
      });
      const watchdog = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("body cancellation blocked startup")), 2_000); });
      await assert.rejects(Promise.race([operation, watchdog]), /Timed out waiting for fixture/u);
      assert.equal(canceled, 1, "the stream is canceled without waiting for its producer's acknowledgement");
    } finally {
      clearTimeout(timer);
      acknowledge();
    }
  });
}
