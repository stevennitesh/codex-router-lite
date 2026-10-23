// Loaded only in fresh children whose environment was set by their fixture
// owner before ESM evaluation. Refuse mutation if path defaults escaped it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CALLER_SECRET_PATH, CODEX_HOME, CONFIG_PATH, INTERNAL_SECRET_PATH, STATE_DIR } from "../../src/paths.mjs";

const expectedState = process.env.TEST_CREDENTIAL_STATE_ROOT;
const expectedHome = process.env.TEST_CREDENTIAL_HOME_ROOT;
assert.ok(expectedState && expectedHome && path.isAbsolute(expectedState) && path.isAbsolute(expectedHome));
for (const directory of new Set([expectedState, expectedHome])) {
  assert.equal(readFileSync(path.join(directory, ".credential-fixture"), "utf8"), "synthetic credential fixture");
}
assert.equal(path.resolve(STATE_DIR), path.resolve(expectedState));
assert.equal(path.resolve(CODEX_HOME), path.resolve(expectedHome));
assert.equal(CALLER_SECRET_PATH, path.join(STATE_DIR, "caller-secret"));
assert.equal(INTERNAL_SECRET_PATH, path.join(STATE_DIR, "internal-secret"));
assert.equal(CONFIG_PATH, path.join(CODEX_HOME, "config.toml"));
