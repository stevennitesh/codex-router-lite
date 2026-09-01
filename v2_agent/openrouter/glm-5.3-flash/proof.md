# v2 agent application: `openrouter/glm-5.3-flash`

## Route

- Routed slug: `openrouter/glm-5.3-flash`
- Upstream model ID: `z-ai/glm-5.3-flash`
- Provider: OpenRouter
- Router version: `0.5.1`
- Capability test completed: `2026-08-26T10:26:00.376Z`

This application transfers the accepted v2 capability evidence from the
provider's former preview identity to its disclosed canonical identity. The old
slug is not retained as an alias or compatibility route. OpenRouter now
identifies the same served model as `z-ai/glm-5.3-flash`; the cutover adds an
exact-slug request bridge and fail-closed provider policy without changing the
model that executed the recorded child turns.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Canonical identity | pass | OpenRouter's model and endpoint records now publish the former preview as `z-ai/glm-5.3-flash`, with the same 1,048,576-token context family and tool-capable endpoints. |
| Streaming Responses | pass | Before disclosure, the same OpenRouter-served model streamed text and a completion event with HTTP 200 at `2026-08-26T10:24:05.461Z`. |
| Forced function call | pass | The same capability probe returned the requested function name and valid JSON arguments with HTTP 200 at `2026-08-26T10:24:05.461Z`. Current bridge tests preserve named tool choice and constrain routing to endpoints that support the full parameter set. |
| Encrypted relay | pass | A native Codex parent created a fresh child on this OpenRouter-served model; the child received the encrypted delegated task and completed with HTTP 200. |
| Marker-return spawn | pass | The fresh child returned the first exact certification marker at `2026-08-26T10:25:23.059Z`. |
| Same-thread follow-up | pass | The existing child received a second task and returned the second exact marker at `2026-08-26T10:26:00.376Z`. |

## Limits and reviewer reproduction

The accepted child evidence predates the provider's public canonical rename;
it is continuity evidence for the same model, not a claim that the old slug is
still supported. The current route additionally has deterministic bridge tests
for exact model rewriting, thinking replay, named tool choice, unsupported
native-field removal, and provider selection. A live canonical probe attempted
during the cutover received HTTP 401 from the configured credential, so no new
success timestamp was substituted into this record.

After the guarded restart, reproduce with a working OpenRouter credential: run
the exact route's stream/tool probe, spawn one fresh GLM-5.3-Flash child with an
exact marker, and send a second marker task to the same child. Do not record
prompts, decrypted payloads, credentials, caller capabilities, or response
bodies in repository evidence.
