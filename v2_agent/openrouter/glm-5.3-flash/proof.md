# v2 agent application: `openrouter/glm-5.3-flash`

## Route

- Routed slug: `openrouter/glm-5.3-flash`
- Upstream model ID: `z-ai/glm-5.3-flash`
- Provider: OpenRouter, pinned to NovitaAI
- Router version: `0.5.1`
- Current application status: accepted

The old slug is not retained as an alias or compatibility route. The current
route uses the canonical `z-ai/glm-5.3-flash` identity and a fail-closed
OpenRouter policy restricted to NovitaAI. All observations below came from
that exact route after the credential refresh.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Canonical identity | pass | OpenRouter publishes `z-ai/glm-5.3-flash`; endpoint `7e1222fc-b9ab-4299-b75a-dd80e1ccd206` identifies NovitaAI, and the shipped policy restricts the route to provider slug `novita` with fallback disabled. |
| Streaming Responses | pass | The exact route streamed a response and completion with HTTP 200 at `2026-09-02T00:24:34.026Z`. |
| Function call | pass | The endpoint declined forced selection, then returned the offered `codex_router_probe` call with valid JSON arguments and HTTP 200. Codex does not force tool choice in ordinary turns. |
| Encrypted relay | pass | The Codex desktop parent created a fresh child on `openrouter/glm-5.3-flash` at high effort. |
| Marker-return spawn | pass | The fresh child returned the exact first marker at `2026-09-02T00:25:20.938Z`. |
| Same-thread follow-up | pass | The same child returned the exact second marker at `2026-09-02T00:25:51.641Z`. |

## Limits and reviewer reproduction

The standalone `codex exec` parent cannot launch a routed child while signed in
with a ChatGPT account. That is a CLI account-policy refusal, not a route
failure. The encrypted relay, marker return, and same-child follow-up were
therefore reproduced through the Codex desktop app's native v2 orchestration
path, which is the path this route ships for. Repository evidence contains no
prompts, decrypted payloads, credentials, caller capabilities, or response
bodies.
