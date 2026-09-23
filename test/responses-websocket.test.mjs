import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { handleResponsesWebSocketUpgrade } from "../src/responses-websocket.mjs";

class FixtureSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.writes = [];
  }

  write(value) {
    this.writes.push(Buffer.from(value));
    this.emit("server-write");
    return true;
  }

  end(value) {
    if (value) this.write(value);
    this.writable = false;
  }

  resume() {}
}

function clientFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff]);
  const encoded = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    encoded[index] = payload[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, mask, encoded]);
}

function serverEvents(socket) {
  const bytes = Buffer.concat(socket.writes.slice(1));
  const events = [];
  let offset = 0;
  while (offset < bytes.length) {
    const opcode = bytes[offset] & 0x0f;
    let length = bytes[offset + 1] & 0x7f;
    let headerBytes = 2;
    if (length === 126) {
      length = bytes.readUInt16BE(offset + 2);
      headerBytes = 4;
    } else if (length === 127) {
      length = Number(bytes.readBigUInt64BE(offset + 2));
      headerBytes = 10;
    }
    const payload = bytes.subarray(offset + headerBytes, offset + headerBytes + length);
    if (opcode === 0x1) events.push(JSON.parse(payload.toString("utf8")));
    offset += headerBytes + length;
  }
  return events;
}

function openPeer(fetchImpl, requestHeaders = {}, options = {}) {
  const socket = new FixtureSocket();
  assert.equal(handleResponsesWebSocketUpgrade({
    method: "GET",
    url: "/responses",
    headers: {
      host: "127.0.0.1",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
      "openai-beta": "responses_websockets=2026-02-06",
      ...requestHeaders,
    },
  }, socket, Buffer.alloc(0), {
    callerKey: "fixture-caller-capability-long-enough",
    responsesUrl: options.responsesUrl || "http://loopback/responses",
    authenticateUpgrade: () => "/responses",
    fetchImpl,
    ...(options.maxEventBytes ? { maxEventBytes: options.maxEventBytes } : {}),
    ...(options.admitUpgrade ? { admitUpgrade: options.admitUpgrade } : {}),
    ...(options.admitRequest ? { admitRequest: options.admitRequest } : {}),
    ...(options.onPeer ? { onPeer: options.onPeer } : {}),
  }), true);
  assert.match(socket.writes[0].toString("ascii"), /^HTTP\/1\.1 101 /u);
  return socket;
}

async function sendRequest(socket, request) {
  const priorEvents = serverEvents(socket).length;
  const completed = new Promise((resolve, reject) => {
    const terminal = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);
    const finish = () => {
      const events = serverEvents(socket).slice(priorEvents);
      if (!events.some(event => terminal.has(event.type))) return;
      clearTimeout(timer);
      socket.off("server-write", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off("server-write", finish);
      reject(new Error("Timed out waiting for a terminal WebSocket event."));
    }, 2_000);
    socket.on("server-write", finish);
  });
  socket.emit("data", clientFrame(request));
  await completed;
  await setImmediate();
  return serverEvents(socket).slice(priorEvents);
}

async function exchange(fetchImpl, request = { type: "response.create", input: [], stream: true }) {
  const socket = openPeer(fetchImpl);
  return { socket, events: await sendRequest(socket, request) };
}

test("WebSocket rejects an invalid completed terminal as one protocol failure", async () => {
  const { events } = await exchange(async () => new Response(
    'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.equal(events[0].error.type, "local_router_protocol_error");
});

test("WebSocket admission rejects upgrades and later logical requests while force closes peers", async () => {
  assert.throws(
    () => openPeer(async () => new Response(), {}, { admitUpgrade: () => { throw new Error("draining"); } }),
    /false !== true/u,
  );

  let open = true;
  let registered;
  const socket = openPeer(
    async () => new Response(JSON.stringify({ id: "resp_ok", status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    {},
    {
      admitRequest: () => { if (!open) throw new Error("draining"); },
      onPeer: (peer) => { registered = peer; return () => {}; },
    },
  );
  open = false;
  const events = await sendRequest(socket, { type: "response.create", input: [], stream: true });
  assert.equal(events[0].status, 503);
  assert.equal(events[0].error.type, "local_router_draining");
  registered.forceClose();
  assert.equal(socket.writable, false);
});

test("WebSocket turns an unterminated internal stream into one stated failure", async () => {
  const { events } = await exchange(async () => new Response(
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ));
  assert.deepEqual(events.map(event => event.type), ["response.output_text.delta", "error"]);
  assert.equal(events[1].error.type, "local_router_stream_failed");
});

for (const ending of ["\n", ""]) {
  test(`WebSocket discards a completion at EOF with ${ending ? "one newline" : "no delimiter"}`, async () => {
    let fetches = 0;
    const socket = openPeer(async () => {
      fetches += 1;
      return new Response(
        `data: {"type":"response.completed","response":{"id":"resp_unfinished","status":"completed","output":[]}}${ending}`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const first = await sendRequest(socket, { type: "response.create", input: [], stream: true });
    assert.deepEqual(first.map(event => event.type), ["error"]);
    const replay = await sendRequest(socket, {
      type: "response.create", previous_response_id: "resp_unfinished", input: [], stream: true,
    });
    assert.equal(replay[0].error.code, "previous_response_not_found");
    assert.equal(fetches, 1);
  });
}

for (const delimiter of ["\n\n", "\r\n\r\n"]) {
  test(`WebSocket accepts a completion with ${JSON.stringify(delimiter)} framing`, async () => {
    const { events } = await exchange(async () => new Response(
      `data: {"type":"response.completed","response":{"id":"resp_complete","status":"completed","output":[]}}${delimiter}`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    assert.deepEqual(events.map(event => event.type), ["response.completed"]);
  });
}

test("WebSocket SSE limits are independent of network chunk partitioning", async () => {
  const body = [
    'data: {"type":"response.output_text.delta","delta":"a"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"b"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_partition","status":"completed","output":[]}}\n\n',
  ].join("");
  const run = async (chunks) => {
    const socket = openPeer(async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }), {}, {
      maxEventBytes: 128,
    });
    return sendRequest(socket, { type: "response.create", input: [], stream: true });
  };
  const whole = await run([body]);
  const split = await run([...body]);
  assert.deepEqual(split, whole);
  assert.deepEqual(whole.map(event => event.type), [
    "response.output_text.delta", "response.output_text.delta", "response.completed",
  ]);
});

test("WebSocket rejects oversized individual SSE lines", async () => {
  const socket = openPeer(async () => new Response(
    `data: ${"x".repeat(129)}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ), {}, { maxEventBytes: 128 });
  const events = await sendRequest(socket, { type: "response.create", input: [], stream: true });
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.equal(events[0].error.type, "ERR_RESPONSES_WS_EVENT_TOO_LARGE");
});

test("WebSocket rejects oversized SSE events made of bounded lines", async () => {
  const socket = openPeer(async () => new Response(
    `data: ${"a".repeat(70)}\ndata: ${"b".repeat(70)}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ), {}, { maxEventBytes: 128 });
  const events = await sendRequest(socket, { type: "response.create", input: [], stream: true });
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.equal(events[0].error.type, "ERR_RESPONSES_WS_EVENT_TOO_LARGE");
});

test("WebSocket applies the same complete comment-line limit to coalesced and split input", async () => {
  const input = `:${"x".repeat(128)}\r\n\r\n`;
  const run = async (chunks) => {
    const socket = openPeer(async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }), {}, {
      maxEventBytes: 128,
    });
    return sendRequest(socket, { type: "response.create", input: [], stream: true });
  };
  for (const chunks of [[input], [...input]]) {
    const events = await run(chunks);
    assert.deepEqual(events.map(event => event.type), ["error"]);
    assert.equal(events[0].error.type, "ERR_RESPONSES_WS_EVENT_TOO_LARGE");
  }
});

test("WebSocket excludes a split CRLF terminator from the line budget", async () => {
  const content = 'data: {"type":"response.completed","response":{"id":"resp_crlf_edge","status":"completed","output":[]}}';
  const socket = openPeer(async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of [content, "\r", "\n\r\n"]) controller.enqueue(Buffer.from(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }), {}, {
    maxEventBytes: Buffer.byteLength(content),
  });
  const events = await sendRequest(socket, { type: "response.create", input: [], stream: true });
  assert.deepEqual(events.map(event => event.type), ["response.completed"]);
});

for (const terminalType of ["error", "response.failed", "response.incomplete"]) {
  test(`WebSocket relays ${terminalType} without appending another terminal`, async () => {
    const { events } = await exchange(async () => new Response(
      `data: ${JSON.stringify({ type: terminalType, error: { message: "fixture failure" } })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    assert.deepEqual(events.map(event => event.type), [terminalType]);
  });
}

test("WebSocket continuation replays produced output once and uses the current tool surface", async () => {
  const requests = [];
  let turn = 0;
  const socket = openPeer(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    turn += 1;
    const item = turn === 1
      ? { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "fixture__inspect", arguments: "{}" }
      : { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "done" }] };
    return new Response([
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${turn}`, status: "completed", output: [item] } })}\n\n`,
    ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const initialInput = [{ role: "user", content: "call the fixture" }];
  const first = await sendRequest(socket, {
    type: "response.create",
    input: initialInput,
    stream: true,
    tools: [{ type: "function", name: "fixture__inspect", parameters: { type: "object" } }],
  });
  assert.deepEqual(first.map(event => event.type), ["response.output_item.done", "response.completed"]);
  const suffix = [{ type: "function_call_output", call_id: "call_fixture", output: "ok" }];
  const second = await sendRequest(socket, {
    type: "response.create",
    previous_response_id: "resp_1",
    input: suffix,
    stream: true,
  });
  assert.deepEqual(second.map(event => event.type), ["response.output_item.done", "response.completed"]);
  assert.deepEqual(requests[1].input, [...initialInput, first[0].item, ...suffix]);
  assert.equal(requests[1].tools, undefined);
  assert.equal(requests[1].previous_response_id, undefined);
});

test("an invalid WebSocket completion cannot leave an older continuation usable", async () => {
  let turn = 0;
  const socket = openPeer(async () => {
    turn += 1;
    const response = turn === 1
      ? { id: "resp_valid", status: "completed", output: [] }
      : { status: "completed", output: [] };
    return new Response(
      `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  assert.deepEqual((await sendRequest(socket, {
    type: "response.create", input: [{ role: "user", content: "first" }], stream: true,
  })).map(event => event.type), ["response.completed"]);
  assert.deepEqual((await sendRequest(socket, {
    type: "response.create", input: [], stream: true,
  })).map(event => event.type), ["error"]);
  const replay = await sendRequest(socket, {
    type: "response.create", previous_response_id: "resp_valid", input: [], stream: true,
  });
  assert.equal(turn, 2);
  assert.equal(replay[0].status, 409);
  assert.equal(replay[0].error.code, "previous_response_not_found");
});

test("an invalid completed JSON response clears an older continuation", async () => {
  let turn = 0;
  const socket = openPeer(async () => {
    turn += 1;
    const response = turn === 1
      ? { id: "resp_json_valid", status: "completed", output: [] }
      : { status: "completed", output: [] };
    return new Response(JSON.stringify(response), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual((await sendRequest(socket, {
    type: "response.create", input: [{ role: "user", content: "first" }], stream: true,
  })).map(event => event.type), ["response.created", "response.completed"]);
  assert.deepEqual((await sendRequest(socket, {
    type: "response.create", input: [], stream: true,
  })).map(event => event.type), ["error"]);
  const replay = await sendRequest(socket, {
    type: "response.create", previous_response_id: "resp_json_valid", input: [], stream: true,
  });
  assert.equal(turn, 2);
  assert.equal(replay[0].error.code, "previous_response_not_found");
});

for (const trailer of ["transport error", "malformed event"]) {
  test(`WebSocket preserves one completed terminal and its continuation after a ${trailer} trailer`, async () => {
    const requests = [];
    let turn = 0;
    const socket = openPeer(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      turn += 1;
      if (turn > 1) {
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp_next","status":"completed","output":[]}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      const terminal = 'data: {"type":"response.completed","response":{"id":"resp_terminal","status":"completed","output":[{"type":"message","id":"msg_terminal","role":"assistant","content":[]}]}}\n\n';
      if (trailer === "malformed event") {
        return new Response(`${terminal}data: {malformed}\n\n`, {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(terminal));
          void setImmediate().then(() => {
            controller.error(new Error("synthetic transport failure after terminal"));
          });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const first = await sendRequest(socket, {
      type: "response.create",
      input: [{ role: "user", content: "retain terminal baseline" }],
      stream: true,
    });
    assert.deepEqual(first.map(event => event.type), ["response.completed"]);
    const second = await sendRequest(socket, {
      type: "response.create",
      previous_response_id: "resp_terminal",
      input: [{ role: "user", content: "continue" }],
      stream: true,
    });
    assert.deepEqual(second.map(event => event.type), ["response.completed"]);
    assert.equal(requests[1].input[1].id, "msg_terminal");
  });
}

test("WebSocket completion releases the serialized queue before upstream EOF", async t => {
  const secondFetchStarted = Promise.withResolvers();
  let hangingController;
  let turn = 0;
  t.after(() => {
    try {
      hangingController?.close();
    } catch {
      // The adapter already canceled the intentionally hanging body.
    }
  });
  const socket = openPeer(async () => {
    turn += 1;
    if (turn === 2) {
      secondFetchStarted.resolve();
      return new Response(
        'data: {"type":"response.completed","response":{"id":"resp_second","status":"completed","output":[]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(new ReadableStream({
      start(controller) {
        hangingController = controller;
        controller.enqueue(Buffer.from(
          'data: {"type":"response.completed","response":{"id":"resp_hanging","status":"completed","output":[]}}\n\n',
        ));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const first = await sendRequest(socket, {
    type: "response.create", input: [{ role: "user", content: "first" }], stream: true,
  });
  assert.deepEqual(first.map(event => event.type), ["response.completed"]);
  const second = sendRequest(socket, {
    type: "response.create", previous_response_id: "resp_hanging", input: [], stream: true,
  });
  let nextFetchTimer;
  try {
    await Promise.race([
      secondFetchStarted.promise,
      new Promise((_, reject) => {
        nextFetchTimer = setTimeout(
          () => reject(new Error("Next WebSocket request remained blocked after completion.")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(nextFetchTimer);
  }
  assert.deepEqual((await second).map(event => event.type), ["response.completed"]);
});

test("WebSocket fixed loopback rejects redirects without replaying its POST", async t => {
  let redirectedRequests = 0;
  let redirectPolicy;
  const target = http.createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"type":"response.completed","response":{"id":"resp_redirected","status":"completed","output":[]}}\n\n');
  });
  await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  const source = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the replayable POST before redirecting, like an ordinary
        // loopback owner that has parsed the request envelope.
      }
      response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/redirected` });
      response.end();
    })();
  });
  await new Promise((resolve, reject) => {
    source.once("error", reject);
    source.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await Promise.all([source, target].map(server => new Promise(resolve => server.close(resolve))));
  });
  const socket = openPeer((url, init) => {
    redirectPolicy = init.redirect;
    return fetch(url, init);
  }, {}, {
    responsesUrl: `http://127.0.0.1:${source.address().port}/responses`,
  });
  const events = await sendRequest(socket, { type: "response.create", input: [], stream: true });
  assert.deepEqual(events.map(event => event.type), ["error"]);
  assert.equal(redirectPolicy, "error");
  assert.equal(redirectedRequests, 0);
});

test("closing a WebSocket cancels the in-flight internal HTTP request", async () => {
  let observedSignal;
  const started = Promise.withResolvers();
  const canceled = Promise.withResolvers();
  const socket = openPeer(async (_url, init) => {
    observedSignal = init.signal;
    started.resolve();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        canceled.resolve();
        reject(init.signal.reason);
      }, { once: true });
    });
  });
  socket.emit("data", clientFrame({ type: "response.create", input: [], stream: true }));
  await started.promise;
  socket.emit("close");
  await canceled.promise;
  assert.equal(observedSignal.aborted, true);
  await setImmediate();
  assert.deepEqual(serverEvents(socket), []);
});

test("WebSocket loopback strips caller auth but preserves native account auth", async () => {
  const observed = [];
  const fetchImpl = async (_url, init) => {
    observed.push(init.headers);
    return new Response(
      'data: {"type":"response.completed","response":{"id":"resp_auth","status":"completed","output":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const callerSocket = openPeer(fetchImpl, {
    authorization: "Bearer fixture-caller-capability-long-enough",
  });
  await sendRequest(callerSocket, { type: "response.create", input: [], stream: true });
  const nativeSocket = openPeer(fetchImpl, {
    authorization: "Bearer native-session-fixture",
    "chatgpt-account-id": "account-fixture",
  });
  await sendRequest(nativeSocket, { type: "response.create", input: [], stream: true });
  assert.equal(observed[0].authorization, undefined);
  assert.equal(observed[1].authorization, "Bearer native-session-fixture");
  assert.equal(observed[1]["chatgpt-account-id"], "account-fixture");
});
