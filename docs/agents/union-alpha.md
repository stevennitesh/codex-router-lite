# Union Alpha compatibility

Read for the exact `openrouter/union-alpha` route. Its owner is
`config/openrouter/union-alpha.json`; `src/union-alpha-compat.mjs` owns measured
request adaptations. Native credential isolation and namespace relay remain
owned by [native Codex compatibility](native-codex.md).

## Endpoint contract

This preview selects OpenRouter's `stealth/union-alpha` through the single
`stealth` endpoint, with fallback disabled and parameter support required.
That pins the public endpoint, not its undisclosed internal model selection.
Do not identify it as GLM, import GLM-specific stream repairs, or infer a fixed
backend from token counts or self-identification.

Ordinary and compaction requests use the internal OpenRouter forwarder's direct
Responses hop. They do not pass through LiteLLM. Existing request-local relays
flatten namespaces, translate native freeform tools into a string-valued
function, and restore calls and their replayed results for Codex.
Compaction translates historical custom calls too: raw native patch history
caused HTTP 200 with `status: failed`, while function-shaped history produced a
valid checkpoint in the paired live probe.

## Maintained behavior

These adaptations follow the dated evidence linked below:

- Text and image input, streaming Responses, developer messages, ordinary
  functions, native patch tools, and tool-result continuation work.
- Reasoning effort, text verbosity, and `parallel_tool_calls` with available
  tools produce OpenRouter parameter-filter errors. Remove these controls only
  for this route; the catalog's `none` effort means provider-controlled reasoning.
- Only automatic tool selection is supported. Implement `tool_choice: none`
  by withholding tools; reject forced choices locally without silently changing
  their meaning. No hosted-search capability is claimed.
- Native deferred tool discovery is enabled independently of hosted web search.
  Namespaced freeform calls preserve native identity, including replay where
  Codex omitted the default `functions` namespace. Do not repair this mismatch
  by adding retries, guessing model families, or parsing calls from prose.
- The advertised window is 262,144 tokens, with up to 131,072 output tokens.
  Compact at 115,000 input tokens to reserve output and framing headroom.
  Tiny output caps on plain requests were not consistently reflected in usage;
  they are not a reliable cost or model-identity probe.
- This route has no exact-route v2 proof and stays at v1. Native CLI execution
  and native app-server tests do not certify encrypted child handoffs or a
  deployed desktop runtime.

The official [model page](https://openrouter.ai/stealth/union-alpha) and
[endpoint API](https://openrouter.ai/api/v1/models/stealth/union-alpha/endpoints)
own public capabilities. Recheck them and the ordinary caller after endpoint
changes; a preview's internals can change without a new slug.

## History, compaction, and cancellation

Undeclared Union historical function names outside the provider-safe alphabet/length receive
collision-safe, reversible aliases. Preserve call IDs, arguments, and results;
do not delete rejected attempts or enable historical tools. This also applies to
compaction. Native GPT requests and other routes do not use this adaptation.

Compaction recovers historical discovery identities and removes native discovery
control items from the provider transcript. The Router source catalog retains
their evidence; no recovered tool becomes available during compaction. Explicit
failed, incomplete, and pending provider results return an error, even with HTTP
200. The deterministic checkpoint fallback remains only for completed responses
that missed the requested summary format. Malformed JSON and envelopes without
an output array are provider errors, not eligible fallback summaries.

The OpenRouter forwarder cancels provider requests when its caller disconnects,
including after the complete POST body but before response headers. Successful
response completion does not trigger cancellation.

## Validation and remaining release work

Run the Union, namespace-relay, compaction-checkpoint, and empty-completion-guard
tests, then the retained suite, npm run check, and current native catalog check.
[Historical investigation and candidate proofs](union-alpha-history.md) record
the original observations and controlled comparisons; they are not live status.
Keep scratch payloads and logs under generated/union-alpha with no credentials
or private project-file contents.

The candidate still needs deployment validation and exact-route v2 certification.
Existing GLM and Switchyard proof records describe their prior deployed runtime;
shared protocol changes require fresh runtime-bound proofs before release claims.
