# Reasoning alias precedence repair — 2026-10-08

Historical investigation and source acceptance, not current runtime authority.
The maintained rule lives in [request preparation](../agents/request-preparation.md).

## Diagnosis

The model-policy audit observed that a primary `reasoning` object took precedence
in local effort validation while a conflicting scalar `reasoning_effort` still
reached final provider send. An object-shaped alias was already removed there.
Ordinary Router and internal-forwarder loopback captures reproduced that mismatch.

The current [OpenRouter Chat API reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
defines `reasoning_effort` as shorthand and prohibits differing simultaneous
values. This establishes a wire-contract violation without relying on a model's
answer to identify its reasoning setting. The direct Responses endpoint's actual
conflict interpretation was not measured.

## Repair

The existing endpoint preparer removes `reasoning_effort` when the primary
`reasoning` field is present. It runs before translation and at final send,
preserving the same precedence throughout both entry paths. An empty primary
object remains intentional, scalar-only callers retain compatibility, and an
unsupported primary effort cannot fall back to a valid alias. Pareto continues
to remove provider-controlled reasoning settings through its existing adapter.

Removing the alias only at final send would leave conflicting settings available
to Chat translation. Rejecting every conflict would change the established
primary-field precedence. The shared preparation owner resolves both concerns
without another adapter or provider-specific exception.

## Evidence

- Both new regression assertions failed before the implementation change: shared
  preparation retained the alias, and an actual local HTTP capture retained it.
- All 33 focused route tests passed afterward, including ordinary Router and
  internal-forwarder captures for both DeepSeek routes, four-profile preparation
  and compaction, input preservation, scalar-only compatibility and Pareto checks.
- `npm run verify:codex` passed all 668 tests with zero skips. Codex CLI
  `0.162.0-alpha.2` parsed 17 current-schema models and passed all route compatibility
  checks. No provider inference, live configuration changes, runtime replacement
  or native certification was performed.

This record establishes source correctness. Deployment and runtime-bound proof
renewal require their own authorized acceptance.
