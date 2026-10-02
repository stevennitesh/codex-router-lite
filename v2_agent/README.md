# v2 route applications

This directory contains exact-route certification applications for models
published as subagents v2. The records are runtime-bound historical evidence,
not current instructions or proof of a later candidate. Keep these paths because
the application checker consumes them; the maintained procedure is
[certification](../docs/SUBAGENT-CERTIFICATION.md).

The four active applications record accepted native desktop certification for
Router `04a971fc98d3d19c5818e8492a92c0e53fe9a596` with Codex
`0.159.0-alpha.12.1` on 2026-10-02. Each application records its exact runtime
and passing native collaboration window:

- accepted: [`openrouter/glm-5.3-flash`](openrouter/glm-5.3-flash/proof.md)
- accepted: [`openrouter/glm-5.3-flash-gmicloud`](openrouter/glm-5.3-flash-gmicloud/proof.md)
- accepted: [`openrouter/pareto`](openrouter/pareto/proof.md)
- accepted: [`switchyard/auto`](switchyard/auto/proof.md)
- retired historical acceptance: [`openrouter/union-alpha`](openrouter/union-alpha/proof.md), which does not certify Pareto.

The [2026-10-02 renewal](../docs/history/2026-10-02-native-v2-certification.json)
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
