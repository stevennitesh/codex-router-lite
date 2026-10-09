# v2 route applications

This directory contains exact-route certification applications for models
published as subagents v2. The records are runtime-bound historical evidence,
not current instructions or proof of a later candidate. Keep these paths because
the application checker consumes them; the maintained procedure is
[certification](../docs/SUBAGENT-CERTIFICATION.md).

Each application's `proof.json` records its exact runtime and execution scope.
Routes can be renewed independently; this index does not assign one shared
commit or test window to every application. The dated run records below retain
the observations for each accepted batch:

- accepted: [`openrouter/glm-5.3-flash-streamlake`](openrouter/glm-5.3-flash-streamlake/proof.md)
- retired historical acceptance: [`openrouter/glm-5.3-flash`](openrouter/glm-5.3-flash/proof.md), which does not certify StreamLake.
- accepted: [`openrouter/glm-5.3-flash-together`](openrouter/glm-5.3-flash-together/proof.md)
- accepted: [`openrouter/deepseek-v4.1-flash-together`](openrouter/deepseek-v4.1-flash-together/proof.md)
- accepted: [`openrouter/deepseek-v4.1-flash-deepinfra`](openrouter/deepseek-v4.1-flash-deepinfra/proof.md)
- retired historical acceptance: [`openrouter/glm-5.3-flash-gmicloud`](openrouter/glm-5.3-flash-gmicloud/proof.md), which does not certify Together.
- accepted: [`openrouter/pareto`](openrouter/pareto/proof.md)
- accepted: [`switchyard/auto`](switchyard/auto/proof.md), using GPT-6.1 Sol High.
  Its unchanged [previous acceptance](../docs/history/2026-10-08-switchyard-sol-medium-proof/proof.md)
  covers the retired Sol Medium policy.
- retired historical acceptance: [`openrouter/union-alpha`](openrouter/union-alpha/proof.md), which does not certify Pareto.

The [runtime primitives renewal](../docs/history/2026-10-09-runtime-primitives-certification.json)
passed all five checks for Switchyard on deployed commit
`3aa818e771b1e644cf891752787f5ea9acbf04b7`. Its three native child requests
and separate streaming request returned HTTP 200. The child produced sandboxed
output 42, received two encrypted handoffs and returned both markers in the same
thread. Cleanup cancelled no active turns. This renews Switchyard's Router-commit
binding; the other five routes retain the Sol High release proofs below.
The run used session-only MXC and does not certify the desktop's elevated sandbox
or arbitrary MCP tools. The [release record](../docs/history/2026-10-09-runtime-primitives-release.md)
records deployment acceptance and verification scope.

The [Sol High release renewal](../docs/history/2026-10-09-sol-high-release-certification.json)
passed all five checks for all six routes on deployed commit
`952339029991e9afb063758b083a195e56a61c41`. All 18 native child requests
and six separate streaming requests returned HTTP 200. Each child produced
sandboxed output 42, received two encrypted handoffs and returned both markers
in the same thread. Completed-turn cleanup cancelled no active turns.
Switchyard's additional tool continuation, image fallback and native compaction
checks passed with evidence attributed to their own requests. The run used
session-only MXC; it does not certify the desktop's elevated sandbox or arbitrary
MCP tools. The [release record](../docs/history/2026-10-09-sol-high-release.md)
also records the frozen routing-quality evaluation and deployment acceptance.

The [credential-state release renewal](../docs/history/2026-10-08-credentials-state-certification.json)
passed all five checks for Switchyard on deployed commit
`a3fe490d6e7cbdc9fb5b27aeb2c4515860680370`. The three native child requests
and separate streaming request returned HTTP 200. The child produced sandboxed
output 42, received two encrypted handoffs and returned both markers in the
same thread. Completed-turn cleanup cancelled no active turns. This renews
Switchyard's Router-commit binding; the other five routes retain their accepted
Windows-service release proofs below. The run used session-only MXC and does
not certify the desktop's elevated sandbox or arbitrary MCP tools.

The [Windows-service release renewal](../docs/history/2026-10-08-windows-service-certification.json)
passed all five checks for all six routes on deployed commit
`75172c2c002b2a6485ca6ae9ae7eb448339033bb`. All 18 native child requests
and six separate streaming requests returned HTTP 200. Each child produced
sandboxed output 42, received two encrypted handoffs and returned both markers
in the same thread. Completed-turn cleanup cancelled no active turns.
Switchyard's proof binds the unchanged binary and routes to the deployed Router
commit. These CLI proofs used session-only MXC with workspace-write and
on-request approval; they do not certify the desktop's elevated sandbox or
arbitrary MCP tools.

The preceding [completion/drain repair renewal](../docs/history/2026-10-08-workflow-repair-certification.json)
passed all five checks for StreamLake, both DeepSeek routes, Pareto and
Switchyard on deployed commit `5b05a931ba707f1bbc5d7f999fe6c8fc023cc76a`.
All 15 native requests and five separate streaming requests returned HTTP 200.
GLM Together returned provider HTTP 429 before its native sequence and was not
renewed. Its preceding application remains historical evidence. The
[release record](../docs/history/2026-10-08-audit-release.md) records that refusal
and the retained recovery set. These CLI proofs used session-only MXC with
workspace-write and on-request approval.

The preceding [audit-fix OpenRouter renewal](../docs/history/2026-10-08-audit-openrouter-certification.json)
passed all five checks for StreamLake, GLM Together, both DeepSeek routes and
Pareto on deployed commit `475b3a79ae52fd219499f17e2925ba7527f7d009`.
All 15 native child requests and five separate streaming requests returned
HTTP 200. These CLI proofs used session-only MXC with workspace-write and
on-request approval.

The [latency and settings renewal](../docs/history/2026-10-07-latency-settings-certification.json)
passed all five checks for GLM Together, both DeepSeek routes, Pareto and
Switchyard on deployed commit `c95a10b926de218971c85727efa31eae407eb8af`.
All 15 native child requests and five separate streaming requests returned
HTTP 200. A separate StreamLake attempt returned HTTP 429 before its native
sequence; its earlier accepted application was not renewed. The
[deployment record](../docs/history/2026-10-07-latency-settings-release.md)
records the scope and retained recovery set. These CLI proofs used session-only
MXC and do not certify the desktop's elevated sandbox or arbitrary MCP tools.

The earlier [maintenance overhaul renewal](../docs/history/2026-10-07-maintenance-overhaul-certification.json)
passed all five checks for all six routes. Six separate synthetic requests
established streamed text and completion on the same deployed generation.
All 18 native child requests completed with HTTP 200, with output 42, two
encrypted handoffs and both markers for each child. The additional Switchyard
tool continuation, image fallback and compaction checks also passed.

The earlier [2026-10-07 certification](../docs/history/2026-10-07-mxc-native-v2-certification.json)
passed all five checks for all six routes after deployment of the nullable
tool-search namespace repair. Every child produced real sandboxed output 42,
received two encrypted handoffs, and returned both markers; all 18 routed
requests completed with HTTP 200. This CLI evidence does not certify the
desktop's elevated sandbox or MCP server tools. The
[sandbox investigation](../docs/history/2026-10-07-codex-sandbox-investigation.md)
records the separate elevated-helper defect and supported MXC comparison.

The earlier [2026-10-06 renewal](../docs/history/2026-10-06-tool-union-native-v2-certification.json)
passed all five checks for each route after guarded deployment of the tool schema
repair. Source CI passed both Windows jobs and the Python dependency audit.
The three Switchyard requests also crossed from Sol Medium to Luna Max within
one child session.

The earlier [2026-10-05 renewal](../docs/history/2026-10-05-native-v2-certification.json)
passed all five checks for each route after guarded deployment. The separate
[Novita capacity attempt](../docs/history/2026-10-05-novita-capacity-attempt.json)
failed its second turn; a fresh successful child supplied the accepted proof.
[Switchyard live checks](../docs/history/2026-10-05-switchyard-live-certification.json)
record the additional bounded tool, image-fallback, compaction and Jev checks.

The earlier [2026-10-02 renewal](../docs/history/2026-10-02-native-v2-certification.json)
passed all five checks for each route after a protected credential refresh and
managed restart. The [earlier expired-key attempt](../docs/history/2026-10-02-expired-key-certification-attempt.json)
remains separate failed evidence and does not contribute to the accepted window.

For preparation, proof fields, acceptance, refresh conditions, and quota
authorization, follow [certification](../docs/SUBAGENT-CERTIFICATION.md).
The templates remain under [`_template/`](_template/proof.json).
The application checker rejects missing, draft, mismatched, or incomplete
applications and requires both proof files.
