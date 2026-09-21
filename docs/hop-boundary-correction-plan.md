# Hop credentials and local error propagation

2026-09-20. Baseline `84e19e3cae9f58baf1dcd7b49bb59440fbbe401b`.
Status: HB1 implemented in the working tree; integrated review pending.

## Outcome

Switchyard's private capability must reach only its local hop, including when the
public route uses native compaction. Recognized local validation errors must keep
their useful code through the outer Router without exposing upstream messages.
Keep current routing, compaction models, relay validation and certification policy.

Source inspection confirms destination selection excludes both compaction forms
while header selection does not. The error translator also replaces recognized
local codes with numeric status strings. These belong in existing owners.

## Required corrections

1. Compute actual Switchyard-hop selection once and reuse it for destination,
   credentials and body encoding. Ordinary Switchyard turns remain uncompressed
   and authenticated to Switchyard. Both compaction variants use native headers,
   native model and native encoding; never attach the local capability to them.
   Preserve native auth, account metadata and existing compaction semantics.
2. Preserve a narrow set of known Router-owned validation codes across the local
   forwarder-to-Router path using fixed safe messages and appropriate status.
   Never disclose arbitrary response messages because they contain a familiar code.
   Keep genuine provider-error behavior. Trace provenance: an authenticated local
   forwarder can itself carry provider errors, so its URL alone does not establish
   that an error was authored locally. Use the smallest sufficient distinction,
   stripping any provider-supplied local marker if one is introduced. No generic
   error protocol or new translation framework.
3. Change the encrypted-child entry in `config/switchyard/README.md` to current
   relay/projection contract and source ownership first. Retain completed plans
   only as explicitly historical rationale. No new context hierarchy.

Redundant post-read bounds may be removed only when the same enforced bound is
demonstrated at the read call; this is optional, not a separate cleanup objective.
No new parser work, model policy, Rust patch, upstream repin or v2 promotion.

## Delivery and review

One implementation slice; final integrated gate HB1 against the baseline.

- Extend actual Router integration tests: local capability present on ordinary
  Switchyard request; absent on V1 and V2 native compaction; native auth/model and
  destination correct; Switchyard receives no compaction. Exercise compressed
  native forwarding where the existing fixture supports it.
- End-to-end public Router -> real internal forwarder rejection -> public error:
  isolate a smaller forwarder body limit, require 413 and request_body_too_large
  with safe local wording and no provider request. Keep malformed JSON behavior.
- Include recognized validation and unrecognized/provider errors, including a
  provider error imitating a local code/marker. Preserve provider treatment and
  do not leak marker payloads through the new safe-code path.
- Run focused tests, npm run verify, current catalog and application checks.
- Review the complete diff for credential leakage, meaningful error preservation,
  safety of message disclosure, and scope. Record source evidence and limits.

## Release obligations

Source implementation does not establish live acceptance. The four affected
applications remain v1/draft. Existing pending relay-selection, completion and
strict-decoding live checks must run on the same final deployed candidate with
fresh native extraction fidelity and tool/continuation proof before renewal.
Managed service-generation replacement must issue a fresh Switchyard capability;
do not print or retain its value. Preserve rollback. Installed use of the affected
compaction path has not been established.

Commit/push, installed replacement/restart and quota-consuming live certification
remain separate release actions. No public tag/release is included.

## HB1 source evidence

Candidate baseline: `84e19e3cae9f58baf1dcd7b49bb59440fbbe401b` plus the
working-tree diff recorded by this plan.

- Router now derives one actual Switchyard-hop predicate and reuses it for the
  private destination, capability header and uncompressed body. V1 and V2
  compaction retain native authorization, account metadata, model, destination
  and zstd encoding without the Switchyard capability.
- The authenticated OpenRouter forwarder marks only locally authored safe
  validation responses and strips the marker from provider responses. Router
  recognizes an allowlisted code only when that provenance marker is present,
  then emits fixed wording and status. Unknown codes and provider imitations
  retain provider-error translation.
- Integration coverage exercises ordinary Switchyard routing, both native
  compaction forms, a smaller real forwarder body limit with no provider call,
  malformed JSON, recognized local validation, and a provider imitation of the
  local code and exact trusted marker. The imitation is checked directly at the
  authenticated forwarder to prove the provider marker is stripped, then through
  the public Router to prove ordinary provider translation is retained.

Source checks completed on 2026-09-20:

- Focused error-translation, Router and forwarder tests passed.
- `npm run verify` passed (262 tests).
- Current catalog compatibility passed (`codex-cli 0.155.0-alpha.9.2`; 13
  current-schema models; GLM, Pareto and Switchyard compatible).
- `node scripts/check-v2-agent-applications.mjs` passed (5 applications valid).
- `git diff --check` passed.

Source verification does not establish installed or live acceptance. No managed
runtime was replaced or restarted, no paid provider call was made, and no
certification state or application status was promoted.
