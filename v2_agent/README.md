# v2 route applications

This directory contains exact-route certification applications for models
published as subagents v2. The records are runtime-bound historical evidence,
not current instructions or proof of a later candidate. Keep these paths because
the application checker consumes them; the maintained procedure is
[certification](../docs/SUBAGENT-CERTIFICATION.md).

The earlier four applications recorded accepted native desktop certification for
Router `c8fea77e8d84e666fe4efd3d3921f380b019be50` with Codex
`0.160.1` on Windows app `26.930.7945.0`, on 2026-10-06 (local date). Each application records its exact runtime
and passing native collaboration window:

- draft/v1: [`openrouter/glm-5.3-flash-streamlake`](openrouter/glm-5.3-flash-streamlake/proof.md)
- retired historical acceptance: [`openrouter/glm-5.3-flash`](openrouter/glm-5.3-flash/proof.md), which does not certify StreamLake.
- draft/v1: [`openrouter/glm-5.3-flash-together`](openrouter/glm-5.3-flash-together/proof.md)
- draft/v1: [`openrouter/deepseek-v4.1-flash-together`](openrouter/deepseek-v4.1-flash-together/proof.md)
- draft/v1: [`openrouter/deepseek-v4.1-flash-deepinfra`](openrouter/deepseek-v4.1-flash-deepinfra/proof.md)
- retired historical acceptance: [`openrouter/glm-5.3-flash-gmicloud`](openrouter/glm-5.3-flash-gmicloud/proof.md), which does not certify Together.
- accepted: [`openrouter/pareto`](openrouter/pareto/proof.md)
- accepted: [`switchyard/auto`](switchyard/auto/proof.md)
- retired historical acceptance: [`openrouter/union-alpha`](openrouter/union-alpha/proof.md), which does not certify Pareto.

The [2026-10-06 renewal](../docs/history/2026-10-06-tool-union-native-v2-certification.json)
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

Create or refresh an application by copying both
[`_template/proof.json`](_template/proof.json) and
[`_template/proof.md`](_template/proof.md). The JSON file is the machine-readable
authority. The Markdown file records the evidence and limitations a reviewer
needs. Do not add another provider or model without a separate product decision.

An accepted proof must identify the public slug, provider, upstream model, Router
and Codex versions, execution path, timestamps, and all five checks. Switchyard
also records its upstream commit, patch, binary, Router, generated-route,
deployed-template, and canonical template-source hashes.

The checker rejects a v2 catalog declaration whose matching application is
missing, draft, mismatched, or incomplete. It also rejects an application
directory missing either proof file. Read `docs/SUBAGENT-CERTIFICATION.md` for
the refresh conditions and quota boundary.
