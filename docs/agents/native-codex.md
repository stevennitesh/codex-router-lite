# Native Codex compatibility

Read for native catalog, app-tool namespaces, encrypted child handoffs, or native
credential forwarding. Start with the [compatibility refresh](compatibility-maintenance.md)
for installed-version or upstream drift. For a GLM-specific wire failure, also
read [OpenRouter GLM](openrouter-glm.md).

## Native Codex and the Windows app

Native GPT entries come from the installed Codex catalog. Preserve unfamiliar fields generically. Never replace the native catalog with a copied list.

The managed service runs `catalog.mjs --refresh-if-stale` every five minutes in
a separate watcher process. The freshness identity is the resolved Codex
binary path, file identity, reported version, and the content fingerprint of
the current account or explicitly adopted native catalog. While signed in, the
locked refresh may update Codex's own `models_cache.json` only from the fixed
ChatGPT account-model endpoint. It bounds the response, rechecks account
identity before writing, never stores credentials, and preserves the prior
cache on every network, schema, or account-switch failure. Cache validators
belong to one CLI version: upgrades fetch unconditionally and older clients
cannot overwrite newer caches. Publication uses
the normal state-ownership guard, catalog lock, and rollback path. A failed
refresh leaves Router serving and retries on the next interval. The watcher
does not override native `visibility` or manufacture account entitlements.

Native HTTP and WebSocket requests preserve Codex authorization, account, residency, and FedRAMP headers. External OpenRouter requests must not receive them. Switchyard receives native authorization only through its authenticated loopback hop.

`src/codex-app-tools.mjs` is a reference snapshot for drift inspection. Runtime
relay uses the caller's definitions and native tool-search discoveries, without
adding snapshot tools. Current app tools use `mcp__codex_app`; legacy namespaces
remain supported when explicitly supplied. Routed tools are flattened for the
model and restored to those request-local identities before app execution.
When Codex changes the tool set, capture it from an ordinary Windows app turn,
update the paired build and snapshot, then test a routed round trip.

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
128 failure entries. Native compaction metadata may be absent, null, or numeric;
compatibility checks must compare against the current native model contract.

The scheduled-task launcher, arguments, source root, ACL, generation, and running process form one service identity. A same-named foreign task is a conflict.
