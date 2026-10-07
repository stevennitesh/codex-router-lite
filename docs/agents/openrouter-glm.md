# OpenRouter GLM compatibility

Read for exact GLM endpoint policy, LiteLLM Responses repair, hosted search, or
Python dependency changes. For app-tool or encrypted handoff failures, also read
[native Codex compatibility](native-codex.md). Use [debugging](debugging.md) for wire failures and
[compatibility maintenance](compatibility-maintenance.md) for app/upstream drift.

## OpenRouter GLM-5.3-Flash

Both OpenRouter routes use upstream `z-ai/glm-5.3-flash`. The canonical
`openrouter/glm-5.3-flash-streamlake` route is pinned to StreamLake FP8 (`streamlake/fp8`). The explicit
`openrouter/glm-5.3-flash-together` route is pinned to Together. Each route
selects one endpoint with fallback disabled and owns its endpoint compatibility
flags and v2 proof. Do not turn the two records into an ordered fallback list.
To add or replace an endpoint, create or update one exact route, then refresh
that route's proof before publishing v2.

StreamLake has a 1,024,000-token context and compacts at 880,000; Together has
1,048,575 tokens and compacts at 900,000. Both default to maximum reasoning,
temperature 1, top-p 0.95 and 128,000 output tokens. Explicit caller settings
take precedence; output above 128,000 tokens is rejected locally.

StreamLake supports automatic tool selection only. Removing available tools
implements `none`; required, named and forced hosted-search choices fail locally.
Together supports required and named function choices. Both omit the unsupported
parallel scheduling hint. Endpoint observations and sources are recorded in the
[2026-10-06 research](../history/2026-10-06-openrouter-route-refresh.md).

Router's request-local custom-tool bridge converts native custom tools to
JSON-schema functions, states that input must parse against the supplied grammar,
and restores completed calls to `custom_tool_call`. This avoids the ambiguous
grammar-as-format description from the gateway. LiteLLM 1.104.0 owns GLM reasoning
history replay, converting Responses reasoning to assistant `reasoning_content`.
Router also owns namespace/collision restoration and exact provider policy.

The pinned gateway also preserves explicit zero token usage in streamed provider
reports and lets later usage reports clear stale cached-token counts. Missing
usage can still require gateway estimation; a reported zero is authoritative.

Ordinary GLM traffic uses LiteLLM to translate Codex Responses traffic.
`src/zai-responses-compat.mjs` repairs malformed GLM envelopes: visible text
after reasoning without message/content opening events, a visible-text close
with a `reasoning_text` part, and overlapping assistant-message and
function-call lifecycles. The transform repairs only those envelope/order
defects and leaves valid streams unchanged. LiteLLM generates distinct
reasoning and message identities itself, so Router Lite does not rewrite those IDs.
Keep the generic namespace relay's identity checks intact.

Fresh hosted-search turns bypass the Chat Completions translation and use the internal OpenRouter forwarder's direct Responses path. `src/openrouter-hosted-search.mjs` maps only native `web_search` and `web_search_preview` tools to the bounded `openrouter:web_search` server tool, restores returned items to `web_search_call`, preserves citations and sources, and reverses completed search history on another direct-search turn. A plain function named `web_search` is unrelated and must remain unchanged. Keep the checked-in Exa engine, result and call limits, exact endpoint policy, and fallback prohibition together. OpenRouter reports live search usage under `server_tool_use_details`; tolerate the documented `server_tool_use` spelling in diagnostics, but never infer zero from an absent field.

After a hosted-search change, test non-streaming output, split SSE item and terminal events, exact completed-history replay, citation/source preservation, mixed ordinary tools, and the internal forwarder's fail-closed bounds. A direct OpenRouter success is still not Windows Codex compatibility proof; deployment acceptance requires one ordinary app search turn and must treat a provider 429 as capacity rather than a schema failure.

For a compatibility failure follow [debugging](debugging.md), tracing LiteLLM
as well as Router and OpenRouter. A direct endpoint success is not Codex proof.

Do not enable fallback or select an unproved endpoint as an outage response. A new endpoint or model is a separate product decision.

### Python dependency lock

Load this branch only when changing the LiteLLM or FastAPI pins.
`requirements/python.in` owns the direct versions; `src/install-plan.mjs`
validates the required gateway packages, security floor, hashed lock, and
dependency stamps. Change the input once, then regenerate the compiled lock
from the repository root:

```powershell
uv pip compile --python-platform windows --generate-hashes --python-version 3.10 --output-file requirements/python.txt requirements/python.in
```

Run the [common source checks](architecture.md#verification) afterward. The lock
check rejects mismatched direct pins, unsupported compile flags, missing hashes,
and versions below the LiteLLM security floor. Installer tests exercise the
actual uv and pip branches with the hash-checked lock. Audit the complete
production closure with the pinned auditor used by CI:

```powershell
uvx --python 3.10 --from pip-audit==2.10.1 pip-audit --disable-pip --no-deps --require-hashes -r requirements/python.txt
```

Do not suppress individual advisories to make the audit pass; update or otherwise
reconcile the affected dependency. Booting the gateway remains required before
accepting a dependency upgrade; a successful resolution or audit alone does not
prove runtime compatibility.
