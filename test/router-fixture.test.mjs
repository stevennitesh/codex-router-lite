import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ready } from "./router-fixture.mjs";

test("fixture readiness bounds both missing headers and a body that never finishes", async t => {
  let mode = "headers", requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    if (mode === "body") { response.writeHead(200); response.write("partial"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const child = { exitCode: null, errors: () => "synthetic hanging service" };
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
  const child = { exitCode: null, errors: () => "synthetic service" }, url = `http://127.0.0.1:${server.address().port}`;
  await ready(url, child);
  await assert.rejects(ready(url, child, {}, { timeoutMs: 80, accept: response => response.ok }), /Isolated service not ready/u);
  status = 200;
  await ready(url, child, {}, { accept: response => response.ok });
});
