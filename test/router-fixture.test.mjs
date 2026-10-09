import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { ready, stop } from "./router-fixture.mjs";

test("fixture readiness bounds both missing headers and a body that never finishes", async t => {
  let mode = "headers", requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    if (mode === "body") { response.writeHead(200); response.write("partial"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const child = { exitCode: null, signalCode: null, errors: () => "synthetic hanging service" };
  for (mode of ["headers", "body"]) {
    const started = performance.now();
    await assert.rejects(ready(`http://127.0.0.1:${server.address().port}`, child, {}, { timeoutMs: 120, probeTimeoutMs: 40 }), /Isolated service not ready/u);
    assert.ok(performance.now() - started < 2_000, "readiness exceeded its bounded fixture budget");
  }
  assert.ok(requests >= 2, "actual loopback probes reached both hanging responses");
});

test("fixture readiness keeps caller-specific success conditions", async t => {
  let status = 401;
  const server = http.createServer((_request, response) => { response.writeHead(status); response.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const child = { exitCode: null, signalCode: null, errors: () => "synthetic service" }, url = `http://127.0.0.1:${server.address().port}`;
  await ready(url, child);
  await assert.rejects(ready(url, child, {}, { timeoutMs: 80, accept: response => response.ok }), /Isolated service not ready/u);
  status = 200;
  await ready(url, child, {}, { accept: response => response.ok });
});

test("fixture readiness rejects actual normal and signalled child exits despite a responding endpoint", async t => {
  let child, terminateDuringProbe = false;
  const server = http.createServer(async (_request, response) => {
    if (terminateDuringProbe) {
      const ended = once(child, "exit"); child.kill(); await ended;
    }
    response.end("ready");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const scenario of ["normal", "signal", "during probe"]) {
    child = spawn(process.execPath, ["-e", scenario === "normal" ? "process.exit(7)" : "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    child.errors = () => `terminated ${scenario} child`;
    try {
      if (scenario !== "during probe") {
        const ended = once(child, "exit");
        if (scenario === "signal") child.kill();
        await ended;
        if (scenario === "signal") { assert.equal(child.exitCode, null); assert.equal(child.signalCode, "SIGTERM"); }
      } else terminateDuringProbe = true;
      await assert.rejects(ready(url, child), /terminated .* child/u);
    } finally { await stop(child); }
  }
});
