# Troubleshooting

For request, replay, tool or stream defects use [debugging](agents/debugging.md).
This guide owns service and operator diagnosis. Start with read-only checks:

```powershell
.\model-router.ps1 codex doctor
```

If a restricted shell reports that protected state is missing, Codex is signed
out, or a provider runtime is unavailable, repeat the same read-only check with
the supported approval mechanism under the Windows user that owns `%CODEX_HOME%`.
Distinguish access denial from confirmed absence; a successful owner-context read
resolves that ambiguity. Administrator elevation is not required merely to read
the user's state. Do not change ownership, weaken ACLs, or reinstall to bypass
the sandbox's access restrictions.

Capability setup creates keys only when their files are confirmed absent. An
unreadable or invalid existing key stops setup before either capability is
changed. Resolve access under its owning Windows user or restore a known-good
generation; do not delete protected state to bypass a read error. Capability
status is read-only. Intentional caller-key changes use the rotation transaction.

Generated-state writes also stop when an existing installation manifest cannot
establish ownership. Restore a valid manifest before retrying. An intentionally
ownerless version-1 manifest retains its existing initialization behavior; an
installer ownership transfer remains explicit.

Do not paste the full managed loopback URL, keys, bearer tokens, account IDs, prompt bodies, or unredacted logs into an issue.

## Codex native models are wrong

Check the current installed Codex catalog:

```powershell
node scripts/check-codex-catalog-compat.mjs --current
```

The installed build owns native models. Do not repair drift by copying a catalog from another version.

The managed service checks for native catalog authority changes every five
minutes, refreshes the signed-in account metadata from the fixed ChatGPT model
endpoint into a protected Router-owned snapshot, and reconciles the desired
publication with current local settings. Codex's `models_cache.json` is never
written by Router. A failed account read preserves a same-identity snapshot;
an account, residency, or client change cannot reuse old validators or old
visibility. A model
whose native entry still has `visibility: "hide"` remains absent by design;
automatic refresh cannot turn a staged account rollout into an entitlement.

## Native or provider requests fail with a connect timeout

A transport error carrying `UND_ERR_CONNECT_TIMEOUT` means Router did not
establish the TCP connection before its connect-phase bound. It is not evidence
that the provider received or executed the request.

The process-wide direct and opted-in proxy dispatchers use a 3-second default
connect bound. `CODEX_ROUTER_CONNECT_TIMEOUT_MS` may override it from 500 ms
through 30 seconds. The default pre-header retry budget is derived from the same
bound, so the retry loop can actually absorb transient connect failures instead
of discovering them only after its budget has expired.

Do not raise the timeout merely to hide a persistently unreachable network
path. Check DNS, proxy selection, local interface/routing, and whether the same
origin is reachable outside Router. Inference POSTs retry only conclusive
connection failures. Socket resets, header timeouts and HTTP 5xx are returned
without automatic replay: the upstream may already have accepted the request.
The retry budget and caller permission are checked again after backoff and
cleanup, before an extra dispatch. Images retain their no-retry policy.

## Provider errors wait without completing

The shared payload caps default to 128 MiB for requests and 8 MiB for buffered
responses. `MODEL_ROUTER_MAX_BODY_BYTES` and
`MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES` accept positive safe integer byte
counts. Their `CODEX_ROUTER_` aliases remain supported when the corresponding
`MODEL_ROUTER_` setting is unset. An invalid, fractional or infinite setting
stops startup with its name; use a byte count such as `8388608`, not `8MiB`.

Router collects routed error diagnostics for at most one second by default,
independently of the long generation deadline. A timeout, oversized body or
broken stream discards the diagnostics and preserves the known HTTP status and
Retry-After guidance. `CODEX_ROUTER_ERROR_BODY_TIMEOUT_MS` may adjust this
collection limit from 50 ms through 10 seconds. Successful reasoning and SSE
requests keep their existing execution budget. Caller cancellation or a shorter
execution deadline still ends the request first.

## GLM fails

Confirm the selected slug is `openrouter/glm-5.3-flash-streamlake` for StreamLake or
`openrouter/glm-5.3-flash-together` for Together. Check that the OpenRouter key
is present and Doctor names both exact endpoint policies. Preserve a sanitized
response event order. Separate Router, LiteLLM, OpenRouter, the selected
endpoint, and model failures before editing.

StreamLake rejects forced tool choices; select automatic tool use or the Together
route when a caller needs required or named calls. DeepSeek's exact route names
and limits are listed in its [endpoint guide](agents/openrouter-deepseek.md).

Do not turn on fallback or select an unproved provider to hide an endpoint failure.

### StreamLake returns 429

A 429 alone does not identify whose limit was reached. Inspect a sanitized
OpenRouter error from the exact endpoint: `error.metadata.limit_source =
"upstream_provider_shared_pool"` with `provider_name = "StreamLake"` means
OpenRouter's shared StreamLake capacity refused the request. Check key status
separately before concluding that the user's credits or key quota are exhausted.
LiteLLM can omit this metadata from the translated error message.

Restoring shared capacity requires OpenRouter/StreamLake to restore or raise its
limit. Refreshing the OpenRouter key, reinstalling Router, or changing supported
tool settings does not repair that cause. A missing `Retry-After` leaves the
recovery time unknown. Retry later, or explicitly select the existing Together
route if work must continue; the StreamLake route must retain its exact pin.
OpenRouter's [provider-key integration](https://openrouter.ai/docs/guides/overview/auth/byok)
can use a provider account's own limits where that integration is supported;
verify StreamLake eligibility and capacity before treating BYOK as a resolution.

## Pareto fails

Confirm the selected slug and exact Unbiased endpoint. Follow the
[Pareto contract](agents/pareto.md) for supported controls and replay, then
[debugging](agents/debugging.md) to locate the first divergence. Do not apply
GLM repairs based on an inferred model identity.

## Unsupported verbosity warning

`model_verbosity is set but ignored` means a global or task override requested a
control the selected model does not support. Remove that override to use each
model's catalog default. External routes correctly advertise no verbosity
support; do not change their capability flags to silence the warning. Preserve
an intentional verbosity preference in a native-only configuration when needed.

## Unsupported subagent effort

`unsupported_reasoning_effort` means a saved override is outside that route's
advertised levels. Router rejects it locally before contacting the provider.
Set a supported level with `model-router.ps1 codex subagents effort <route> <level>`;
omit the level to clear the override and follow the route's default. Other route
settings remain unchanged.

## App functions do not execute

Capture the failing request's current tool declaration and namespace metadata
from the app turn, then check the flattened provider call and restored namespace
as a pair. Router does not ship a static Desktop tool registry: the request-local
client definition is the authority. A provider returning plausible JSON does not
prove the app received a native tool call.

## Switchyard is unavailable

Read the [Switchyard boundaries](../config/switchyard/README.md) and
[runtime diagnosis](../config/switchyard/runtime.md). Load the build/deployment
branch only if replacement is needed. Verify the locked source, patch, binary,
generated route, capability file, provenance, and health as one unit. Do not
copy one artifact from another generation.

Start with the redacted current-generation summary:

```powershell
.\model-router.ps1 codex switchyard-trace
```

| Observation | First owner to inspect |
| --- | --- |
| A Jev fallback reason appears | Use the maintained [fallback reason table](../config/switchyard/runtime.md#runtime-supervision-and-diagnosis) to distinguish expected Sol fallback from client, deadline, HTTP, schema, or state-bound failures. |
| A generative-judge error appears | The log is from a retired Switchyard generation. Identify that generation and consult [historical evidence](history/README.md) instead of applying its workaround to current Jev. |
| `routed_agents: 0` with accepted v2 proofs | Local subagent mode or its selected allowlist filtered every certified exact route. Run `model-router.ps1 codex subagents status` before changing source. |
| Deployment waits on dependency preparation, then rejects an old rollback | The deployment script is stale. Current source checks candidate and rollback directories before preparing dependencies. |

The trace command reports counts and continuity only. It never prints request
bodies, headers, capabilities, or raw agent identifiers.

When collecting certification evidence after the failure owner is resolved,
use the bounded redacted view instead of copying either raw log:

```powershell
.\model-router.ps1 codex switchyard-certification-evidence --limit 20
```

## Windows task mismatch

For a checkout deployment, read the private `resultPath` and `logPath` returned
by the deployment command. A started worker or healthy HTTP endpoint does not
confirm completion. If a manual install recorded the candidate while a verified
rollback checkout remains live, use the retained-backup recovery option in
[Switchyard maintenance](../config/switchyard/maintenance.md#deploy-and-roll-back).
Do not reinstall repeatedly over the live old process or discard its backup.

A task with the expected name but different launcher, arguments, source root, ACL, or generation is foreign. Do not adopt or overwrite it. Use the installer or guarded restart transaction after resolving ownership.

The installer grants `BUILTIN\Users` read and execute access only to the Router program tree so its Limited scheduled task can load the installed modules. Protected credentials and state remain owner-only. A module-resolution error naming an existing path does not prove a task-token access failure. Readiness uses output written after the service launch began; check the launch entry, installed dependencies, path type and task account access before changing permissions or reinstalling.

Never stop Router separately during maintenance. If the user has not authorized a restart, report that a restart is required and stop before changing the live service.

If an update or restart reports `ERR_ROUTER_DRAIN_DEFERRED` or
`ERR_ROUTER_DRAIN_UNSUPPORTED`, follow the
[restart and waiting policy](INSTALL.md#replacement-and-drain). Router was left
running because work is unfinished or that older version cannot wait for
requests to finish. Let the work finish before retrying. Restarting without
waiting interrupts running requests and requires explicit approval; never do it
automatically.

The service task has a minute heartbeat and `MultipleInstances=IgnoreNew`.
While Router is running, a duplicate heartbeat launch may set Task Scheduler's
last result to `0x800710E0`. This means Windows rejected the duplicate task
instance. Confirm Router health, task state, launcher identity, and the next
heartbeat time before treating it as a failure.

## Stream progress or pre-content failure

Routed SSE accepts LF, CRLF, mixed endings and bare CR without waiting for the
next event to expose completed reasoning. Shared framing mechanics live in
`src/sse-framing.mjs`; namespace restoration keeps its own bounded rewrite policy.

OpenRouter search restoration and GLM envelope repair use these same framing
mechanics. They join multiline data and honor the last SSE event field, checking
it against the JSON type. Safe repeated fields are collapsed before downstream
namespace and message-phase restoration. Unaffected single-field frames retain
their original bytes. An unfinished EOF event is preserved without inferring a
close or successful completion.

Provider repairs check raw UTF-8, duplicate decoded JSON keys and numeric
precision before changing data. Unsafe input remains raw and disables further
repair when no repair has committed; after a repair commits it causes an explicit
failure. Numeric tokens inside ordinary function argument strings stay exact.
GLM compatibility limits an event, held output and retained message text to
8 MiB each, with at most 4,096 held output groups. Hosted search retains its
32 MiB JSON limit and 8 MiB line limit, plus an 8 MiB event limit. Exceeding a
limit fails the response; it does not trigger another inference attempt.

A `precontent_limit` time or byte failure has an unknown inference outcome.
Router cancels that attempt and returns an explicit failure without another
POST. Only a known completed-empty turn whose prologue stayed suppressed gets
one quiet repair. Large prompts retain their scaled prefill allowance.

## Conversation cuts after restarting Codex

Restarting the Windows Codex app closes its local app-server connection. An
active turn may end with an interruption marker even when Router stayed
healthy. Completed thread history remains stored and can resume after the app
returns. Do not make Router keep a detached provider stream alive because the
new app-server connection cannot reattach to it safely.

A v2 child can also fail history hydration when the app tries to resume it
before loading its parent. The desktop log states that the unloaded parent must
resume first or the client must use `thread/read`. Open the parent task first,
then inspect its child. Diagnose this as native app hydration unless Router
health or the persisted thread file also failed.
