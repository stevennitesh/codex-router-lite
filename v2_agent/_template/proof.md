# v2 agent application: `<provider>/<model>`

## Route

- Routed slug: `provider/model`
- Upstream model ID: `exact-provider-id`
- Provider endpoint: `https://…` (redacted to an origin/path with no capability)
- Router version and commit: pending
- Codex version/build: pending
- Execution surface: pending (`codex exec` runner or Codex desktop native orchestration)
- Test date: pending

## Evidence

Use outcome summaries only. Do not paste raw prompts, response bodies,
encrypted payloads, API keys, bearer tokens, or caller URLs.

| Check | Result | Redacted summary |
| --- | --- | --- |
| Official model identity | pending | Link the official docs and catalog evidence. |
| Streaming Responses | pending | Status, completion event, timestamp. |
| Function call | pending | Selection mode (`forced` or exact-profile `auto`), status, requested-name verdict, and valid JSON-argument verdict. |
| Encrypted relay | pending | Native parent to routed child completed; no payload text. |
| Marker-return spawn | pending | Exact marker returned to parent. |
| Same-thread follow-up | pending | Second marker returned on the existing child thread. |

## Limits and reviewer reproduction

State any known provider limitation and the minimal, redacted steps for a
reviewer with their own account to reproduce the two native child checks.
