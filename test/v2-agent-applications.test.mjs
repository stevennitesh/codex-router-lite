import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateV2AgentApplications } from "../scripts/check-v2-agent-applications.mjs";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProof = slug => JSON.parse(readFileSync(path.join(root, "v2_agent", slug, "proof.json"), "utf8"));
const families = [
  ["active OpenRouter", "openrouter/deepseek-v4.1-flash-together"],
  ["retired OpenRouter", "openrouter/glm-5.3-flash"],
  ["Switchyard", "switchyard/auto"],
];
const invalidCommits = [undefined, "", "g".repeat(40), "a".repeat(39), "a".repeat(41), null, 123, ["a".repeat(40)]];

function withApplication(proof, check) {
  const applicationsRoot = mkdtempSync(path.join(tmpdir(), "v2-application-"));
  const directory = path.join(applicationsRoot, proof.slug);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "proof.md"), "# Synthetic proof\n\n## Evidence\n");
  const route = MODEL_BY_SLUG.get(proof.slug);
  const validate = changed => {
    writeFileSync(path.join(directory, "proof.json"), JSON.stringify(changed));
    return validateV2AgentApplications(applicationsRoot, { models: route ? [route] : [] });
  };
  try { check(validate); }
  finally { rmSync(applicationsRoot, { recursive: true, force: true }); }
}

for (const [family, slug] of families) {
  test(`${family} accepted proof requires a valid Router commit`, () => {
    const proof = readProof(slug);
    withApplication(proof, validate => {
      assert.equal(validate(proof).length, 1);
      for (const value of invalidCommits) {
        const changed = structuredClone(proof);
        if (value === undefined) delete changed.routerCommit;
        else changed.routerCommit = value;
        assert.throws(() => validate(changed), /routerCommit/u, `accepted ${family} commit: ${JSON.stringify(value)}`);
      }
    });
  });

  test(`${family} accepted proof permits historical commits and hexadecimal case`, () => {
    const proof = readProof(slug);
    withApplication(proof, validate => {
      // No Git object lookup or equality to current HEAD is required for historical evidence.
      for (const commit of ["0123456789abcdef".repeat(2) + "01234567", proof.routerCommit.toUpperCase()]) {
        const changed = structuredClone(proof);
        changed.routerCommit = commit;
        if (changed.runtimeBinding) changed.runtimeBinding.routerCommit = commit.toLowerCase();
        assert.equal(validate(changed)[0].status, "accepted");
      }
    });
  });
}

test("Switchyard accepted proof rejects conflicting or non-string binding commits", () => {
  const proof = readProof("switchyard/auto");
  withApplication(proof, validate => {
    const conflicting = structuredClone(proof);
    conflicting.runtimeBinding.routerCommit = proof.routerCommit === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
    assert.throws(() => validate(conflicting), /runtimeBinding\.routerCommit/u);
    const coerced = structuredClone(proof);
    coerced.runtimeBinding.routerCommit = [proof.routerCommit];
    assert.throws(() => validate(coerced));
  });
});

test("blank draft template does not require accepted Router identity", () => {
  const proof = JSON.parse(readFileSync(path.join(root, "v2_agent", "_template", "proof.json"), "utf8"));
  withApplication(proof, validate => {
    assert.equal(validate(proof)[0].status, "draft");
  });
});
