# v2 route applications

This directory contains exact-route evidence for models published as subagents v2.

Each retained route has one directory:

- `openrouter/glm-5.3-flash`
- `switchyard/auto`

Copy `_template/proof.json` only when refreshing one of those routes. Do not add another provider or model without a separate product decision.

An accepted proof must identify the public slug, provider, upstream model, Router and Codex versions, execution path, timestamps, and all five checks. Switchyard also records its upstream commit, patch, binary, Router, and generated-route hashes.

The checker rejects a v2 catalog declaration whose matching application is missing, draft, mismatched, or incomplete. Read `docs/SUBAGENT-CERTIFICATION.md` for the refresh conditions and quota boundary.
