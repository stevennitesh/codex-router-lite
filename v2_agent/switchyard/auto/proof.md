# v2 agent application: `switchyard/auto`

## Route

- Routed slug: `switchyard/auto`
- Registry upstream model ID: `gpt-5.6-sol`
- Provider: locally installed NVIDIA NeMo Switchyard
- Router version: `0.4.0-beta.4`
- Test completed: `2026-08-26T12:42:45.381Z`

Switchyard may select Luna high/max or Sol medium/high/xhigh for an ordinary
turn. `gpt-5.6-sol` is the public route's registry identity, not a claim that
every certified child turn used Sol.

## Evidence

| Check | Result | Redacted summary |
| --- | --- | --- |
| Official model identity | pass | NVIDIA NeMo's Switchyard documentation identifies its standalone server, OpenAI Responses support, streaming translation, tool-call protocol types, and model-routing algorithms. The installed `/v1/models` endpoint exposed the configured route. |
| Streaming Responses | pass | A same-child marker turn streamed and completed through the installed Router and Switchyard process with HTTP 200 at `2026-08-26T12:39:19.911Z`. |
| Forced function call | pass | The child received only a file path, emitted one `exec_command` call with valid JSON arguments, read an unknown marker, received the tool result, and returned the exact contents. Codex recorded `task_complete` at `2026-08-26T12:41:46.344Z`; transport metering was the expected client-close status 0 after the tool loop completed. |
| Encrypted relay | pass | A native Codex parent created a fresh named Switchyard child. The persisted child received the delegated task and completed at `2026-08-26T12:38:57.177Z`. |
| Marker-return spawn | pass | The fresh child returned the first exact certification marker. The rollout recorded `task_complete`; Router metering recorded client-close status 0 after the final item rather than an upstream failure. |
| Same-thread follow-up | pass | The existing child received a second exact-marker task and completed through Switchyard with HTTP 200 at `2026-08-26T12:39:19.939Z`. |

## Limits and reviewer reproduction

Reproduction requires Switchyard to be enabled, an active Codex app session, and
native multi-agent v2. Local ChatGPT session sharing may remain disabled because
the real child path forwards the app's authentication. Spawn a fresh
`switchyard/auto` child with an exact marker, send a second marker task to the
same child, then require that child to read an unknown temporary file marker with
a real tool call. Verify the function call and output in the child rollout, both
task-complete events, Switchyard routing records, and Router metering. Do not
record prompts, decrypted payloads, credentials, caller capabilities, or response
bodies in repository evidence.
