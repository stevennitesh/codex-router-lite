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
- accepted: [`switchyard/auto`](switchyard/auto/proof.md)
- retired historical acceptance: [`openrouter/union-alpha`](openrouter/union-alpha/proof.md), which does not certify Pareto.

The [maintenance overhaul renewal](../docs/history/2026-10-07-maintenance-overhaul-certification.json)
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
