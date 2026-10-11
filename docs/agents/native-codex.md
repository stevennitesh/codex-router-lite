# Native Codex compatibility

Read for native catalog, app-tool namespaces, encrypted child handoffs, or native
credential forwarding. Start with the [compatibility refresh](compatibility-maintenance.md)
for installed-version or upstream drift. For a GLM-specific wire failure, also
read [OpenRouter GLM](openrouter-glm.md).

## Native Codex and the Windows app

Native GPT entries come from the installed Codex catalog. Preserve unfamiliar fields generically. Never replace the native catalog with a copied list.

`codexExecutableIdentity` selects one executable for each catalog publication or
Doctor operation. Version, authentication, and capture use that path; later
operations discover afresh. Capture checks its producer's fingerprint before and
after execution and rejects drift instead of attaching another build's identity.

The managed service runs `catalog.mjs --refresh-if-stale` every five minutes in
a separate watcher process. The freshness identity is the resolved Codex
binary path, file identity, reported version, and the content fingerprint of
the current account or explicitly adopted native catalog. While signed in, the
locked refresh stores account metadata from the fixed ChatGPT account-model
endpoint in Router's protected `native-account-models.json`; Codex alone owns
`models_cache.json`. The snapshot contains no credential and is reusable only
for the matching account or authentication identity, residency, and CLI
version. Account, residency, and client changes discard prior validators; a
failed identity-changing refresh cannot reuse the prior account's visibility.
An unchanged successful account revalidation records `validated_at` in the same
private snapshot. Unforced refreshes reuse that validation for five minutes;
older snapshots fall back to `fetched_at`, and explicit forced refresh still
fetches. This timestamp does not change model fingerprints or rewrite unchanged
published catalogs.
An explicitly adopted native source remains the selected authority and does not
read or refresh the unused account snapshot; native authentication publication
rules still apply to its models.
The request is bounded, rechecks identity before writing, and preserves the
last snapshot on network or schema failure. Publication uses the normal
state-ownership guard, catalog lock, and rollback path. Every watcher pass
derives the desired publication from the reusable capture and current local
settings, then writes only changed catalog, announcement, or managed-agent
output. A failed publication therefore retries on the next interval even when
the native capture itself is current. Invalid native input preserves the last
publication. An incompatible enabled optional route is omitted with its managed
agent and a bounded diagnostic; disabled providers are not projected. The
watcher does not weaken route compatibility, override native `visibility`, or
manufacture account entitlements.

Provider, picker and subagent settings distinguish confirmed absence from invalid
or inaccessible existing state. Absence retains the established first-use
defaults. Invalid existing state stops publication before seeding or changing
output; status commands report the failure without inventing effective choices.
An explicit full provider `set` can replace that provider selection. Supported
legacy picker files still reconstruct visible choices from their seeded/hidden
sets.

Operator settings mutations acquire the same publication lock before reading
and replacing their state. Publisher seeding runs inside its already-held lock,
so an overlapping operator choice waits and then updates the current generation.
Read-only status and inference do not acquire this lock. Required managed-agent
removal failures trigger publication recovery; incomplete agent restoration is
not reported as a rollback-safe result.

Native discovery retains the managed static catalog until the installed client
proves a supported refresh path that preserves the built-in provider, account
authentication and full native model metadata. Before any migration, repeat the
installed strict-config and same-process app-server probes and separately verify
desktop picker adoption; an accepted unknown setting or an upstream symbol is not
that proof. The current version-specific capability decision is retained in the
[historical record](../history/2026-09-22-native-discovery-capability.md).

Native HTTP and WebSocket requests preserve Codex authorization, account, residency, and FedRAMP headers. External OpenRouter requests must not receive them. Switchyard receives native authorization only through its authenticated loopback hop.

For caller-owned native sessions, `src/native-responses-websocket.mjs` keeps one
upstream connection per client connection, forwards real `generate: false`
prewarm requests, and preserves produced `previous_response_id` continuations.
Credential, session, thread or model changes require a fresh connection and a
full normalized baseline. Bounded retained history supports this transition and
idle reconnects; missing history fails explicitly. Requests already sent upstream
are not replayed after transport failure. Admission, execution deadlines,
backpressure and service drain apply to native WebSocket turns as well as HTTP.
External routes, substituted native credentials and compaction triggers retain
the HTTP preparation path.

Native HTTP inference POSTs recover only from conclusive connection failures,
within the bounded retry budget. A socket reset, header timeout or gateway 5xx
does not establish that the upstream never accepted the request, so Router
returns that failure without automatic replay. Caller output and cancellation
also prohibit replay. The explicit routed empty-completion repair keeps its
separate completed-response and usage-accounting policy: it requires a parsed
completed-empty result with every prologue byte still suppressed. A pre-content
time or byte failure has an unknown inference outcome and returns
`precontent_limit` without another POST. Prompt-scaled prefill allowance remains.

The WebSocket edge captures masked frames and external SSE lines incrementally,
with allocation growing only as bytes arrive. Native request input is serialized
once for both the outgoing JSON and exact continuation byte accounting. Validated
native events and already restored external events retain their JSON when forwarded;
parsed events still govern protocol, terminal, metadata and continuation checks.
Locally generated events use normal serialization. Byte bounds, UTF-8 rejection,
fragment/control handling and backpressure apply to both forwarding forms.

Native HTTP inspection reuses original JSON bytes or zstd frames when compatibility
normalization makes no changes. Effort metadata is cached by catalog file identity;
replacement, rewrite or invalid state invalidates it. Desktop-generation capture
runs alongside dispatch and resolves inside the ordered authentication-observation
queue. Consented credential refresh and binary discovery use asynchronous
subprocesses, retaining their timeouts and refresh throttle.

Desktop app tools are never sourced from a checked-in snapshot. Runtime relay
uses only the caller's request-local definitions and native tool-search
discoveries, so a Desktop-only plugin can add, remove, or change schemas without
Router manufacturing stale capabilities. Current app tools commonly use
`mcp__codex_app`; legacy namespaces remain supported when explicitly supplied.
Routed tools are flattened for the model and restored to those request-local
identities before app execution. Custom calls retain both namespace and name.
Codex may omit its default `functions` namespace in stored custom calls;
resolve that shorthand against the current declaration so replay uses the same
provider spelling. An exact plain declaration wins, and other namespaces must
not be guessed. Tests use synthetic app namespaces to verify the generic relay
contract rather than freezing a private Desktop schema.

The catalog's `supports_search_tool` gates client-side deferred tool discovery,
not hosted web search. External routes declare `supportsToolSearch` separately
from their `searchTool` web-search policy. Conflating these hides deferred app
tools before Router sees the request. Recheck this distinction against current
[Codex tool planning](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)
during compatibility maintenance rather than treating a versioned source line
as permanent.

Flattened tool names must remain unique even when a plain function has the same
spelling as a namespace child. Use the request-local alias map consistently for
declarations, forced/allowed tool choices, returned calls, and replay. Native
requests do not pass through this external-provider name translation.

An unqualified provider call can omit `namespace` or set it to `null`. Restore
both forms consistently for ordinary functions, custom tools, and the declared
client tool-search relay before Codex dispatch. History and tool choices use the
same identity rules. Exact plain declarations take precedence over app-like
spellings and receive no inferred app arguments. An explicit namespace belongs
to its stated owner; ambiguous bare names remain unresolved.

Ordinary external turns and compaction share `src/routed-request.mjs`, which
returns the prepared payload and its matching namespace context. For changes
to this ownership or the preparation order, read
[request preparation](request-preparation.md).

Child completion and cancellation belong to Codex and the caller. Relay only
model-authored collaboration calls; injecting an interrupt after a prior final
answer can cancel a newly resumed child.

The installer supplies delegated-wait and finished-child cleanup guidance through
the managed `multi_agent_v2.root_agent_usage_hint_text`. Desktop root tasks can
replace the generic `developer_instructions` value while assembling app context,
but they retain this native root-agent hint. Keep wait policy here rather than in
the Responses proxy or a skill; the active delegation workflow owns its interval.

When replaying routed history to native Codex, omit optional foreign item IDs
on messages, function calls, and custom calls. Preserve native IDs and every
`call_id`; tool outputs must remain paired with their calls. Unknown
provider-prefixed model names fail locally instead of falling through to the
native account endpoint.

Preflattened MCP and harness function/custom declarations can recover their
namespace from reserved turn metadata only when the exact declaration is
present and unambiguous. Metadata never grants an additional tool. Routed
assistant SSE messages receive missing commentary/final phases from item order;
provider phases win, reasoning alone does not imply commentary, and malformed,
ambiguous, oversized, or unsuccessful streams receive no inferred final answer.

Encrypted child handoffs preserve native 401 and 429 failures. A 429 suppresses
repeat handoffs for the same account-scoped payload for 60 seconds, with at most
128 failure entries. SSE extraction uses the shared CR/LF framing scanner,
joins multiline data, and checks the final `event` field against the JSON type
unless it is empty or `message`. Conflicting labels, failed terminals and
unfinished events cannot populate the success cache or reach an external route.
Native compaction metadata may be absent, null, or numeric;
compatibility checks must compare against the current native model contract.

The scheduled-task launcher, arguments, source root, ACL, generation, and running process form one service identity. A same-named foreign task is a conflict.
