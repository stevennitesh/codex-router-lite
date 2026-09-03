# Subagents v2 certification

Read this only when changing exact-route subagent eligibility, encrypted relay, proof records, or `multiAgentVersion`.

A route is spawnable only when its published model has `multiAgentVersion: "v2"`. Certification belongs to one exact public slug and its current provider, upstream model, request profile, endpoint policy, Router behavior, and Codex execution path.

The retained routes are:

- `openrouter/glm-5.3-flash`
- `switchyard/auto`

## Required checks

An accepted proof records one run that passes:

1. streamed Responses text and completion
2. a valid tool call
3. encrypted parent-to-child relay
4. the requested child marker
5. a second marker from the same child thread

Streaming and a tool call alone do not prove native collaboration. Do not promote a partial run.

`v2_agent/<provider>/<route>/proof.json` is the checked-in application. `src/subagent-proofs.mjs` validates it. `src/subagent-routing.mjs` selects only exact eligible routes. `scripts/check-v2-agent-applications.mjs` rejects a v2 declaration without an accepted matching application.

## When to refresh proof

Refresh the exact route after any change to:

- provider, upstream model, or endpoint binding
- request or reasoning policy
- Codex app-function or namespace relay shape
- encrypted relay or child continuation behavior
- Router compatibility transforms
- Switchyard binary, patch, route file, or selected native target behavior
- the proof epoch

Do not reuse another provider's or another slug's result. A local selection is operator intent, not repository certification.

Certification can consume provider or ChatGPT quota. Never run it without explicit authority. A deterministic mock test cannot replace the native parent, child, and same-thread observations.

After an accepted change, run `npm run check`, `npm test`, and the installed-Codex catalog check. For Switchyard, also bind the proof to the locked commit, patch hash, binary hash, generated route hash, and Router commit.
