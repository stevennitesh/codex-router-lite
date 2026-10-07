import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCatalogReader } from "../src/catalog-reader.mjs";
import { normalizeNativeReasoningEffort } from "../src/native-request-compat.mjs";

test("native effort normalization observes rewritten and replaced catalogs", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "catalog-reader-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "models.json");
  const read = createCatalogReader(file);
  const catalog = effort => JSON.stringify({ models: [{ slug: "gpt-fixture", supported_reasoning_levels: [{ effort }] }] });
  const normalize = () => {
    const request = { model: "gpt-fixture", reasoning: { effort: "ultra" } };
    normalizeNativeReasoningEffort(request, read());
    return request.reasoning.effort;
  };
  writeFileSync(file, catalog("medium"));
  assert.equal(normalize(), "medium");
  assert.equal(normalize(), "medium");
  writeFileSync(file, catalog("high"));
  assert.equal(normalize(), "high");
  const replacement = path.join(directory, "replacement.json");
  writeFileSync(replacement, catalog("low"));
  rmSync(file);
  renameSync(replacement, file);
  assert.equal(normalize(), "low");
});

test("missing, invalid, and non-model catalog state discards the prior generation", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "catalog-reader-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "models.json");
  const read = createCatalogReader(file);
  const valid = '{"models":[{"slug":"gpt-fixture"}]}';
  for (const invalid of [undefined, "{", "null", '{"models":false}']) {
    writeFileSync(file, valid);
    assert.equal(read()[0].slug, "gpt-fixture");
    if (invalid === undefined) rmSync(file); else writeFileSync(file, invalid);
    assert.deepEqual(read(), []);
    writeFileSync(file, valid);
    assert.equal(read()[0].slug, "gpt-fixture");
  }
});
