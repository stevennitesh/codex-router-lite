# v2 agent application: `openrouter/glm-5.3-flash-gmicloud`

## Route

- Routed slug: `openrouter/glm-5.3-flash-gmicloud`
- Upstream model ID: `z-ai/glm-5.3-flash`
- Provider: OpenRouter, pinned to GMICloud
- Router version: `0.5.1`
- Codex version/build: `codex-cli 0.153.1`
- Execution surface: Codex desktop native orchestration on Windows
- Current application status: accepted

GMICloud rejects named and required tool selection, so the route uses the
existing exact-profile normalization to `auto`. It also removes
`parallel_tool_calls` before the OpenRouter hop. The managed child definition
pins the route's `max` default effort so an unsupported parent effort such as
`medium` cannot prevent the native child from starting.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Canonical identity | pass | OpenRouter publishes `z-ai/glm-5.3-flash`; the route restricts requests to provider slug `gmicloud` with fallback disabled. |
| Streaming Responses | pass | The exact routed path completed streamed text with HTTP 200 at `2026-09-04T19:51:19.114Z`. |
| Function call | pass | The exact routed path returned the offered `cert_probe` call with valid streamed JSON arguments and HTTP 200 at `2026-09-04T19:51:19.114Z`. Selection mode was `auto`, matching GMICloud's endpoint contract. |
| Encrypted relay | pass | The Windows Codex native parent started the exact GMICloud routed child at `2026-09-04T20:45:52.159Z`. |
| Marker-return spawn | pass | The child returned the first exact marker at `2026-09-04T20:45:52.159Z`. |
| Same-thread follow-up | pass | The same child returned the second exact marker at `2026-09-04T20:46:18.639Z`. |

## Limits and reviewer reproduction

Endpoint metadata and direct probes do not prove native collaboration. The
parent-child and same-child checks above ran through the Windows Codex app's
native collaboration path. An earlier attempt inherited unsupported `medium`
effort and was rejected before a provider request; the recorded run omitted an
override and used the managed route's supported `max` default. Evidence stores only timestamps, statuses,
selection mode, and marker verdicts—not prompts, response bodies, credentials,
capabilities, or decrypted relay data.
