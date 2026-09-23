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
  nativeAccountCatalogIdentity,
  readNativeAccountCatalog,
  refreshNativeAccountCatalogUnlocked,
} from "../src/native-account-catalog.mjs";
import { privateFileIsProtected } from "../src/file-security.mjs";

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
    version: 1,
    identity: nativeAccountCatalogIdentity(headers()),
    fetched_at: "2026-09-05T12:00:00.000Z",
    client_version: "0.153.4",
    etag: 'W/"old-catalog"',
    models,
    ...overrides,
  };
}

function withCache(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-native-account-"));
  const cachePath = path.join(directory, "native-account-models.json");
  return Promise.resolve(run(cachePath)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

const writeCache = async (target, value) => {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

test("client upgrades refetch without old validators and reject unsolicited 304", () =>
  withCache(async (cachePath) => {
    const original = JSON.stringify(fixture([{ slug: "gpt-old" }], { client_version: "0.150.0" }));
    for (const status of [304, 200]) {
      writeFileSync(cachePath, original);
      const result = await refreshNativeAccountCatalogUnlocked({
        cachePath, version: "0.153.4", headersProvider: async () => headers(), writeCache,
        fetchImpl: async (_url, init) => {
          assert.equal(init.headers["if-none-match"], undefined);
          return new Response(status === 304 ? null : JSON.stringify({ models: [{ slug: "gpt-new" }] }), { status });
        },
      });
      assert.equal(result.status, status === 304 ? "failed" : "updated");
      if (status === 304) assert.equal(readFileSync(cachePath, "utf8"), original);
      else assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).models[0].slug, "gpt-new");
    }
  }));

test("client-version revalidation records the new version for unchanged models", () =>
  withCache(async (cachePath) => {
    const models = [{ slug: "gpt-stable" }];
    writeFileSync(cachePath, JSON.stringify(fixture(models, { client_version: "0.150.0" })));
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath,
      version: "0.153.4",
      headersProvider: async () => headers(),
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers["if-none-match"], undefined);
        return new Response(JSON.stringify({ models }), { status: 200 });
      },
      writeCache,
    });
    assert.equal(result.status, "revalidated");
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).client_version, "0.153.4");
  }));

test("304 revalidation rejects an account or residency switch", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixture([{ slug: "gpt-stable" }]));
    for (const changedHeaders of [
      headers("other-account"),
      { ...headers(), "x-openai-fedramp": "true" },
    ]) {
      writeFileSync(cachePath, contents);
      let reads = 0;
      const result = await refreshNativeAccountCatalogUnlocked({
        cachePath,
        force: true,
        version: "0.153.4",
        headersProvider: async () => (++reads === 1 ? headers() : changedHeaders),
        fetchImpl: async () => new Response(null, { status: 304 }),
        writeCache,
      });
      assert.equal(reads, 2);
      assert.deepEqual(result, { status: "failed", identity_changed: true });
      assert.equal(readFileSync(cachePath, "utf8"), contents);
    }
  }));

test("older clients cannot narrow a newer cache, including forced refresh", () =>
  withCache(async (cachePath) => {
    const original = JSON.stringify(fixture([{ slug: "gpt-new" }]));
    writeFileSync(cachePath, original);
    const forbidden = () => { throw new Error("unexpected network or write operation"); };
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath, version: "0.150.0", force: true,
      headersProvider: async () => headers(), fetchImpl: forbidden, writeCache: forbidden,
    });
    assert.equal(result.status, "stale-client");
    assert.equal(readFileSync(cachePath, "utf8"), original);
  }));

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

test("the Router-owned account snapshot uses protected private-file storage", {
  skip: process.platform !== "win32",
}, () => withCache(async (cachePath) => {
  const result = await refreshNativeAccountCatalogUnlocked({
    cachePath,
    force: true,
    version: "0.153.4",
    headersProvider: async () => headers(),
    fetchImpl: async () => new Response(JSON.stringify({
      models: [{ slug: "gpt-protected", visibility: "list" }],
    }), { status: 200 }),
  });
  assert.equal(result.status, "updated");
  assert.equal(privateFileIsProtected(cachePath), true);
}));

test("fresh current-version account snapshot rechecks identity without a network read", () =>
  withCache(async (cachePath) => {
    writeFileSync(cachePath, JSON.stringify(fixture(
      [{ slug: "gpt-current" }],
      { fetched_at: "2026-09-05T17:59:00.000Z" },
    )));
    const forbidden = () => { throw new Error("unexpected network or write operation"); };
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath,
      now: NOW,
      version: "0.153.4",
      headersProvider: async () => headers(),
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

test("account and residency changes discard validators and cannot reuse the prior snapshot", () =>
  withCache(async (cachePath) => {
    const contents = JSON.stringify(fixture([{ slug: "gpt-stable" }]));
    for (const changedHeaders of [
      headers("other-account"),
      { ...headers(), "x-openai-fedramp": "true" },
    ]) {
      writeFileSync(cachePath, contents);
      const result = await refreshNativeAccountCatalogUnlocked({
        cachePath,
        version: "0.153.4",
        headersProvider: async () => changedHeaders,
        fetchImpl: async (_url, init) => {
          assert.equal(init.headers["if-none-match"], undefined);
          throw new Error("synthetic network failure");
        },
        writeCache,
      });
      assert.equal(result.status, "failed");
      assert.equal(result.identity_changed, true);
      assert.equal(readFileSync(cachePath, "utf8"), contents);
    }
  }));

test("a malformed Router snapshot remains an explicit source failure", () =>
  withCache(async (cachePath) => {
    writeFileSync(cachePath, '{"models":[{}]}');
    const result = await refreshNativeAccountCatalogUnlocked({
      cachePath,
      version: "0.153.4",
      headersProvider: async () => headers(),
      fetchImpl: async () => { throw new Error("synthetic network failure"); },
      writeCache,
    });
    assert.deepEqual(result, { status: "failed", native_source_invalid: true });
    assert.equal(readFileSync(cachePath, "utf8"), '{"models":[{}]}');
  }));

test("snapshot reader rejects a merged Router catalog as native authority", () =>
  withCache((cachePath) => {
    writeFileSync(cachePath, JSON.stringify({
      models: [{ slug: "openrouter/glm-5.3-flash" }],
    }));
    assert.deepEqual(readNativeAccountCatalog(cachePath), {
      catalog: undefined,
      fingerprint: undefined,
    });
  }));
