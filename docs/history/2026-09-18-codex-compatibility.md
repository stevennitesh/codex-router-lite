# Codex app and upstream review - 2026-09-18

Historical review evidence; current authority remains the source, upstream review
pointer, Switchyard lock, and exact-route proof records.

## Native app

Verified Windows package 26.915.3509.0 with signed codex-cli 0.155.0-alpha.9.
The ordinary live app registry exposes four additional tools: create_worktree,
attach_artifact, list_artifacts, and remove_artifact. Refreshed the reference
snapshot and verified schema flattening and restoration of their arguments and
namespaces. Runtime relay continues to use the caller's actual definitions.
The seven conditional snapshot entries were not exposed in this ordinary turn
and retain their earlier provenance. Existing ordinary descriptions matched.

The [official changelog](https://learn.chatgpt.com/docs/changelog) describes the
September 17 CLI 0.155.0 release: reasoning/status visibility, task and worktree
management, daemon recovery, and prompt persistence around compaction failures.
That stable release is context, not proof of what the packaged alpha contains.
The current executable parsed our generated catalog; instruction-template
fallback already handles missing base instructions for routed behavior.

## Original Router

Reviewed the 218-commit range a71312d7..5e1b49e6 (including merges), with
non-merge subjects classified by retained ownership and relevant patches
inspected. The machine-readable disposition and deferred candidates are in
maintenance/upstream-router.json. No upstream merge was performed.

Adapted a973995d and b65ea270. Regression tests failed before the fixes: context
errors reported 4 instead of 282974 tokens, and missing scheduled tasks reached
start mutations. Both pass after correction. Existing transactional Windows
installation is stronger than upstream's launcher-only check; retaining a slow
unverified installation would weaken our rollback contract.

Other relevant fixes were already present: custom-history IDs, stored reasoning,
choice-bearing usage, child effort, GLM images, terminal keepalives and TOML
assignment parsing. Malformed function-JSON gating/retries, duplicate reasoning
references, foreign reasoning converted to text, and SSE scanning are explicitly
deferred pending retained-route evidence or measurement. Generic provider/client,
UI, discovery, distribution, and failover changes are outside Lite's boundary.

## Switchyard

Compared pinned a70a1fba with upstream 2be08d30. Retained the pin and canonical
patch. Applying the patch to the newer head conflicts in classifier, affinity,
configuration, server and Responses translation owners. The 1e912482 category
redesign still needs a separate routing-quality evaluation; a mechanical rebase
would change established routing policy.

Deferred 1759dfdf deadlines/routing-error changes and 328591dd streamed metrics
until their behavior is needed in the retained integration. Classifier task-only
input and recursive target reasoning overrides are already locally covered.
Translation fixes for Anthropic, Chat, tools/media and target prompts do not
justify a native Responses routing redesign. In particular 7c8cead6 prevents
caller preservation metadata replacing cross-protocol requests: this integration
uses Responses on both sides, and pinned capture_request_preservation overwrites
the entry for the actual source format. Revisit that fix before enabling any
cross-protocol Switchyard endpoint or target. Loopback capability and native
authorization requirements remain unchanged.

## Validation and delivery

Regression checks cover the changed error and service behavior plus all four new
app-tool round trips. Full source/product checks, the retained suite and current
CLI catalog parsing are required before deployment. Live exact-route results
are recorded separately in v2_agent, bound to the deployed candidate and CLI;
this review does not itself renew older proofs.

Repository bootstrap also refreshes the inherited engineering contract from its
current template, retaining repository-specific policy at the existing owners.

### Delivered result

Deployed Router 4189cbfc1c64886335c506df37f673dd963697a1 successfully.
All 227 tests, source/product checks and the installed 14-model catalog check
passed. Fresh CLI v2 evidence passed for GLM/Novita, GLM/GMICloud and Switchyard.
Their proof records bind this candidate to codex-cli 0.155.0-alpha.9.

Pareto was not recertified: during 2026-09-18T13:11:26Z..13:12:13Z OpenRouter
rejected the configured 65,536-token output reservation with HTTP 402 because
the key's remaining weekly allowance could afford only 54,906 tokens. Native
client retries produced 18 such responses across the two attempted child turns;
no successful tool call or marker occurred. No provider limit or output contract
was changed to make the test pass. The existing Pareto proof remains evidence
for its earlier runtime, not this deployment. Retry fresh certification after
the key allowance is restored or explicitly adjusted. No account/key identifiers
or private payloads are retained in this record.

### Patch-build verification

Windows package 26.915.4065.0 updated the bundled CLI to
0.155.0-alpha.9.2. Its ordinary live app registry contains the same 34 tools as
26.915.3509.0; every exposed description and TypeScript declaration matched the
prior capture. The current catalog parsed successfully, all retained checks
passed, and neither original Router upstream nor Switchyard moved. The app-tool
snapshot was rebound to the exact installed build. Because no app-function or
namespace shape, encrypted relay, request policy, compatibility transform, or
Switchyard artifact changed, the certification refresh conditions were not met;
the earlier exact-route proofs remain historical evidence for their recorded
runtime and were not rewritten for this snapshot-only candidate.

Deployed Router 598bf7bdb3ef267613050639e3146db42949cba7. Fresh ordinary
native CLI smokes passed through GLM/Novita, GLM/GMICloud, Pareto, and
Switchyard: each route made one default-sandbox PowerShell tool call, observed
42, and returned its exact marker. This is app-update transport evidence, not a
replacement for the five-check v2 certification procedure.
