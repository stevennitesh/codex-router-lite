# v2 route applications

This directory contains exact-route certification applications for models
published as subagents v2. The records are runtime-bound historical evidence,
not current instructions or proof of a later candidate. Keep these paths because
the application checker consumes them; the maintained procedure is
[certification](../docs/SUBAGENT-CERTIFICATION.md).

The four active routes have accepted applications for deployed Router
`75ddd5d58c85f392f7b0c9c9f8ea8b1f4acc2f8f`. Each application records its exact runtime
and passing native collaboration window:

- accepted: [`openrouter/glm-5.3-flash`](openrouter/glm-5.3-flash/proof.md)
- accepted: [`openrouter/glm-5.3-flash-gmicloud`](openrouter/glm-5.3-flash-gmicloud/proof.md)
- accepted: [`openrouter/pareto`](openrouter/pareto/proof.md)
- accepted: [`switchyard/auto`](switchyard/auto/proof.md)
- retired historical acceptance: [`openrouter/union-alpha`](openrouter/union-alpha/proof.md), which does not certify Pareto.

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
