# OpenRouter GLM compatibility

The custom-tool relay follows the pinned LiteLLM input conversion: unwrap a
string `content`, otherwise retain raw arguments, including its one-million
Unicode-code-point parse limit. Reject incompatible non-string content and
any disagreement between streamed, completed, and closed input. Fragmented
response preludes may exceed the normal staging budget within the bounded
10 MiB event limit; the empty-completion verdict still applies.

Read for exact GLM endpoint policy, LiteLLM Responses repair, hosted search, or
Python dependency changes. For app-tool or encrypted handoff failures, also read
[native Codex compatibility](native-codex.md). Shared refresh, diagnosis and proof
requirements live in [compatibility maintenance](compatibility-maintenance.md).

## OpenRouter GLM-5.3-Flash

Both OpenRouter routes use upstream `z-ai/glm-5.3-flash`. The canonical
`openrouter/glm-5.3-flash` route is pinned to Novita. The explicit
`openrouter/glm-5.3-flash-gmicloud` route is pinned to GMICloud. Each route
selects one endpoint with fallback disabled and owns its endpoint compatibility
flags and v2 proof. Do not turn the two records into an ordered fallback list.
To add or replace an endpoint, create or update one exact route, then refresh
that route's proof before publishing v2.

Ordinary GLM traffic uses LiteLLM to translate Codex Responses traffic.
`src/zai-responses-compat.mjs` repairs missing message envelopes, separates
message IDs reused from reasoning items, and closes assistant text before an
overlapping tool-call lifecycle on the two exact GLM routes. Test these repairs
through the namespace relay: a duplicate identity can disable restoration of
a later app call. Keep the generic relay's identity checks intact.

Fresh hosted-search turns bypass the Chat Completions translation and use the internal OpenRouter forwarder's direct Responses path. `src/openrouter-hosted-search.mjs` maps only native `web_search` and `web_search_preview` tools to the bounded `openrouter:web_search` server tool, restores returned items to `web_search_call`, preserves citations and sources, and reverses completed search history on another direct-search turn. A plain function named `web_search` is unrelated and must remain unchanged. Keep the checked-in Exa engine, result and call limits, exact endpoint policy, and fallback prohibition together. OpenRouter reports live search usage under `server_tool_use_details`; tolerate the documented `server_tool_use` spelling in diagnostics, but never infer zero from an absent field.

After a hosted-search change, test non-streaming output, split SSE item and terminal events, exact completed-history replay, citation/source preservation, mixed ordinary tools, and the internal forwarder's fail-closed bounds. A direct OpenRouter success is still not Windows Codex compatibility proof; deployment acceptance requires one ordinary app search turn and must treat a provider 429 as capacity rather than a schema failure.

For a compatibility failure, preserve a sanitized event sequence and identify the first divergence among Codex, Router, LiteLLM, OpenRouter, the selected endpoint, and the model. Reproduce through an ordinary Codex caller. A direct endpoint success is not Codex compatibility proof.

Do not enable fallback or select an unproved endpoint as an outage response. A new endpoint or model is a separate product decision.

### Python dependency lock

Load this branch only when changing the LiteLLM or FastAPI pins. Update
`PYTHON_REQUIREMENTS` in `src/install-plan.mjs` and `requirements/python.in`
together, then regenerate the compiled lock from the repository root:

```powershell
uv pip compile --python-platform windows --generate-hashes --python-version 3.10 --output-file requirements/python.txt requirements/python.in
```

Run `npm run check` afterward. It rejects mismatched direct pins, a lock without
the required compile flags or hashes, and installer commands that bypass the
lock. Booting the gateway remains required before accepting a dependency
upgrade; a successful resolution alone does not prove runtime compatibility.
