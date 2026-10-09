import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

const names = ["MODEL_ROUTER_MAX_BODY_BYTES", "CODEX_ROUTER_MAX_BODY_BYTES", "MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES", "CODEX_ROUTER_MAX_BUFFERED_RESPONSE_BYTES"];
let serial = 0;
async function configured(values, operation) {
  const before = names.map(name => process.env[name]);
  try {
    for (const name of names) { if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name]; }
    return await operation(() => import(`../src/http-utils.mjs?byte-settings=${++serial}`));
  } finally {
    names.forEach((name, i) => { if (before[i] === undefined) delete process.env[name]; else process.env[name] = before[i]; });
  }
}

test("body-limit configuration rejects values that could remove bounds", async () => {
  for (const name of names) for (const value of ["8MiB", "Infinity", "NaN", "0", "-1", "1.5", "9007199254740992"]) {
    await configured({ [name]: value }, load => assert.rejects(load(), error => error instanceof TypeError && error.message.includes(name)));
  }
});

test("defaults, compatibility aliases and primary precedence retain bounded real readers", async () => {
  await configured({}, async load => {
    const module = await load();
    assert.equal(module.MAX_BODY_BYTES, 128 * 1024 * 1024);
    assert.equal(module.MAX_BUFFERED_RESPONSE_BYTES, 8 * 1024 * 1024);
  });
  for (const primary of [true, false]) await configured({
    [primary ? names[0] : names[1]]: "32", [primary ? names[2] : names[3]]: "32",
    ...(primary ? { [names[1]]: "Infinity", [names[3]]: "Infinity" } : { [names[0]]: "", [names[2]]: "" }),
  }, async load => {
    const module = await load();
    assert.equal(module.MAX_BODY_BYTES, 32);
    assert.equal(module.MAX_BUFFERED_RESPONSE_BYTES, 32);
    await assert.rejects(module.readRequestBody(Readable.from([Buffer.alloc(33)])), { status: 413, code: "request_body_too_large" });
    await assert.rejects(module.readResponseBody(new Response(Buffer.alloc(33))), { code: "ERR_UPSTREAM_RESPONSE_TOO_LARGE" });
    assert.equal((await module.readRequestBody(Readable.from([Buffer.alloc(32)]))).length, 32);
  });
});
