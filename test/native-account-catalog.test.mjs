import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readModelsCache,
  refreshNativeAccountCatalogUnlocked,
} from "../src/native-account-catalog.mjs";

const ACCESS = "test-native-account-access-token";
const ACCOUNT = "test-native-account-id";
const NOW = Date.parse("2026-09-05T18:00:00.000Z");

function headers(account = ACCOUNT) {
  return {
    authorization: `Bearer ${ACCESS}`,
    "chatgpt-account-id": account,
  };
}

function fixture(models, overrides = {}) {
  return {
    fetched_at: "2026-09-05T12:00:00.000Z",
    client_version: "0.153.4",
    etag: 'W/"old-catalog"',
    models,
    ...overrides,
  };
}

function withCache(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-account-"));
  const cachePath = path.join(directory, "models_cache.json");
  return Promise.resolve(run(cachePath)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

const writeCache = async (target, value) => {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("fixed account endpoint updates only a still-current signed-in session", () =>
  withCache(async (cachePath) => {
    const oldModels = [{ slug: "gpt-old", visibility: "list" }];
    const newModels = [...oldModels, { slug: "gpt-new", visibility: "list" }];
    writeFileSync(cachePath, JSON.stringify(fixture(oldModels)));
    let request;
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath,
      force: true,
      now: NOW,
      version: "0.153.4",
      headersProvider: async () => headers(),
      fetchImpl: async (url, init) => {
        request = { url, init };
        return new Response(JSON.stringify({ models: newModels }), {
          status: 200,
          headers: { etag: 'W/"new-catalog"' },
        });
      },
      writeCache,
    });

    assert.equal(
      request.url,
      "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4",
    );
    assert.equal(request.init.redirect, "manual");
    assert.equal(request.init.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(request.init.headers.originator, "codex_router");
    assert.equal(request.init.headers["user-agent"], "codex-router/0.153.4");
    assert.equal(request.init.headers["if-none-match"], 'W/"old-catalog"');
    assert.equal(result.status, "updated");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCESS, "u"));
    const written = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(written.models, newModels);
    assert.equal(written.client_version, "0.153.4");
    assert.equal(written.fetched_at, "2026-09-05T18:00:00.000Z");
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), new RegExp(ACCESS, "u"));
  }));

test("fresh current-version account cache performs no credential or network read", () =>
  withCache(async (cachePath) => {
    writeFileSync(cachePath, JSON.stringify(fixture(
      [{ slug: "gpt-current" }],
      { fetched_at: "2026-09-05T17:59:00.000Z" },
    )));
    const forbidden = () => { throw new Error("unexpected account operation"); };
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath,
      now: NOW,
      version: "0.153.4",
      headersProvider: forbidden,
      fetchImpl: forbidden,
      writeCache: forbidden,
    });
    assert.equal(result.status, "fresh");
  }));

test("network, schema, and routed-catalog failures preserve the last native cache", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixture([{ slug: "gpt-stable" }]));
    for (const fetchImpl of [
      async () => { throw new Error(`network failure ${ACCESS}`); },
      async () => new Response('{"models":[]}', { status: 200 }),
      async () => new Response(JSON.stringify({
        models: [{ slug: "openrouter/glm-5.3-flash" }],
      }), { status: 200 }),
      async () => new Response("denied", { status: 401 }),
    ]) {
      writeFileSync(cachePath, contents);
      const result = await refreshNativeAccountCatalogUnlocked({
        cachePath,
        force: true,
        version: "0.153.4",
        headersProvider: async () => headers(),
        fetchImpl,
        writeCache,
      });
      assert.equal(result.status, "failed");
      assert.equal(readFileSync(cachePath, "utf8"), contents);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCESS, "u"));
    }
  }));

test("account switch during refresh rejects the fetched catalog", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixture([{ slug: "gpt-stable" }]));
    writeFileSync(cachePath, contents);
    let reads = 0;
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath,
      force: true,
      version: "0.153.4",
      headersProvider: async () => headers(++reads === 1 ? ACCOUNT : "other-account"),
      fetchImpl: async () => new Response(JSON.stringify({
        models: [{ slug: "gpt-other-account" }],
      }), { status: 200 }),
      writeCache,
    });
    assert.equal(result.status, "failed");
    assert.equal(readFileSync(cachePath, "utf8"), contents);
  }));

test("cache reader rejects a merged Router catalog as native authority", () =>
  withCache((cachePath) => {
    writeFileSync(cachePath, JSON.stringify({
      models: [{ slug: "openrouter/glm-5.3-flash" }],
    }));
    assert.deepEqual(readModelsCache(cachePath), {
      catalog: undefined,
      fingerprint: undefined,
    });
  }));
