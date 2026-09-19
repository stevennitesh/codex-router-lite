# Union Alpha compatibility (retired historical contract)

Union Alpha is no longer registered as an active route. This file preserves its
measured contract under the original identity so the historical investigation
and accepted v2 proof remain intelligible. That proof certifies only
`openrouter/union-alpha` at `stealth/union-alpha`; it does not certify Pareto or
make the retired slug callable.

The retired route was `openrouter/union-alpha`. Its owner was
`config/openrouter/union-alpha.json`; `src/union-alpha-compat.mjs` owns measured
request adaptations. Native credential isolation and namespace relay remain
owned by [native Codex compatibility](../agents/native-codex.md).

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
Compaction translates historical custom calls too; raw native custom history
is not valid provider replay on this route.

## Maintained behavior

The catalog uses Sol's native Codex behavior template; this is a compatibility
choice, not evidence about Union's underlying model or the optimal prompt.
Native child sessions may inherit their parent's base instructions. Bounded
task execution and continuation guidance therefore belongs in the generated routed-agent
developer instructions, which also reach those children.

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
  Compact at 220,000 tokens, below Codex's 90% context-window ceiling, to retain
  history with about 42,000 tokens of total-window headroom;
  it does not reserve the provider's maximum output allowance. Large tool
  results or long generations can still exhaust the remaining window.
  Tiny output caps on plain requests were not consistently reflected in usage;
  they are not a reliable cost or model-identity probe.
- This route has an [exact-route v2 proof](../../v2_agent/openrouter/union-alpha/proof.md)
  for native child tool execution, encrypted handoffs and same-child continuation.
  It applies only to the recorded runtime and does not identify the backend model.

The official [model page](https://openrouter.ai/stealth/union-alpha) and
[endpoint API](https://openrouter.ai/api/v1/models/stealth/union-alpha/endpoints)
own public capabilities. Recheck them and the ordinary caller after endpoint
changes; a preview's internals can change without a new slug.

## History, compaction, and cancellation

Compaction prompts state the checkpoint reference and list limits. Structurally
valid summaries that exceed those budgets retain bounded navigation and a
verified subset of exposed sources, with an omission notice. Malformed summaries
remain untrusted; missing, wrong-kind and unexposed references never gain authority.

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

## Validation

Run the Union, namespace-relay, compaction-checkpoint, and empty-completion-guard
tests, then the retained suite, npm run check, and current native catalog check.
[Historical investigation and candidate proofs](2026-09-17-union-alpha.md) record
the original observations and controlled comparisons; they are not live status.
Keep scratch payloads and logs under generated/union-alpha with no credentials
or private project-file contents.

Deployment acceptance requires installed-runtime validation. Shared protocol changes
require fresh affected runtime-bound proofs before release claims; see
[certification](../SUBAGENT-CERTIFICATION.md). Source tests alone do not promote this route.
