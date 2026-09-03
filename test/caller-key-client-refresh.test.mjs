import assert from "node:assert/strict";
import test from "node:test";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  refreshCodexCallerCapabilityContents,
  refreshCodexCallerCapabilityState,
} from "../src/caller-key-client-refresh.mjs";

const oldBase = callerBaseUrl(4202, "o".repeat(48));
const newBase = callerBaseUrl(4202, "n".repeat(48));

test("Codex capability refresh changes only managed caller URLs", () => {
  const before = [
    `openai_base_url = ${JSON.stringify(oldBase)}`,
    'model_catalog_json = "C:/state/merged-models.json"',
    `# copied example must stay ${oldBase}`,
    "",
    "# BEGIN codex-router-provider-managed",
    "[model_providers.codex-router]",
    `base_url = ${JSON.stringify(oldBase)}`,
    'wire_api = "responses"',
    "# END codex-router-provider-managed",
    "",
  ].join("\n");
  const after = refreshCodexCallerCapabilityContents(before, newBase, { port: 4202 });
  assert.equal(after, before
    .replace(`openai_base_url = ${JSON.stringify(oldBase)}`, `openai_base_url = ${JSON.stringify(newBase)}`)
    .replace(`base_url = ${JSON.stringify(oldBase)}`, `base_url = ${JSON.stringify(newBase)}`));
  assert.ok(after.includes(`# copied example must stay ${oldBase}`));
});

test("Codex capability state refresh preserves policy and ownership", () => {
  const before = {
    version: 3,
    mode: "provider-table",
    managedProvider: "example-provider",
    managedBaseUrl: oldBase,
    ownershipId: "a".repeat(32),
    previousProviderSections: ["x"],
  };
  assert.deepEqual(refreshCodexCallerCapabilityState(before, newBase, { port: 4202 }), {
    ...before,
    managedBaseUrl: newBase,
  });
});

test("Codex capability refresh rejects an unmanaged replacement", () => {
  assert.throws(
    () => refreshCodexCallerCapabilityContents(
      `openai_base_url = ${JSON.stringify(oldBase)}\n`,
      "https://example.com/v1",
      { port: 4202 },
    ),
    /invalid Codex router URL/i,
  );
});
