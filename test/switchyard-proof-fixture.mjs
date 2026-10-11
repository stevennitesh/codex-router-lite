import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Synthetic current-source binding for validator tests; never an application
// or a claim that the candidate binary/model has completed native certification.
export function switchyardProofFixture() {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const proof = JSON.parse(read("docs/history/2026-10-08-switchyard-sol-medium-proof/proof.json"));
  const lock = JSON.parse(read("config/switchyard/source.lock"));
  const template = read("config/switchyard/routes.template.toml");
  const hash = value => createHash("sha256").update(value).digest("hex");
  proof.model = "gpt-6.1-sol";
  Object.assign(proof.runtimeBinding, {
    upstreamCommit: lock.commit,
    upstreamContributionCommit: lock.upstreamContribution.sourceCommit,
    upstreamContributionSha256: lock.upstreamContribution.patchSha256,
    patchSha256: lock.patchSha256,
    templateSha256: hash(template),
    templateSourceSha256: hash(template.replace(/\r\n?/gu, "\n")),
    binarySha256: "a".repeat(64), routesSha256: "b".repeat(64),
  });
  return proof;
}
