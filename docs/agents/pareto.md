# Pareto compatibility

Read for the exact `openrouter/pareto` route. Its owner is
`config/openrouter/pareto.json`; `src/pareto-compat.mjs` owns measured request
adaptations. Native credential isolation and namespace relay remain owned by
[native Codex compatibility](native-codex.md).

## Endpoint contract

This route selects OpenRouter's `unbiased/pareto` model through only the
`unbiased` endpoint, with fallback disabled and parameter support required.
Ordinary and compaction requests use the internal OpenRouter forwarder's direct
Responses hop. They do not pass through LiteLLM.

Pareto keeps Sol's native Codex behavior template, a 262,144-token context
window, and a 220,000-token automatic compaction limit. It accepts text and
image input and supports native deferred tool discovery independently of hosted
web search. It is published as v2 with an [accepted native collaboration proof](../../v2_agent/openrouter/pareto/proof.md).
The retired Union Alpha proof does not apply to this route.

The exact Unbiased endpoint advertises a 131,072-token maximum output. Router
rejects explicit limits above it during front preparation and final provider
preparation. It does not set an implicit output budget or sampling defaults:
OpenRouter does not publish those defaults for this endpoint. Context and output
ceilings are separate; a request must also fit its prompt and output within the
context window.

## Measured controls

The exact endpoint accepts automatic function selection. OpenRouter's
`require_parameters` filter rejects literal `none`, `required`, named function
choices, reasoning effort, text verbosity, `parallel_tool_calls`, and Responses
structured formatting. The adapter therefore:

- implements `none` by withholding tools and the tool choice;
- rejects forced choices locally instead of weakening their meaning;
- removes reasoning, verbosity, and parallel controls;
- rejects explicit structured response formats locally instead of weakening the requested output contract;
- preserves the existing namespace and custom-tool bridge for calls and replay.

No hosted-search capability is claimed. Do not infer support from another
Pareto wire API or from OpenRouter's model-level capability list; this route is
the measured direct Responses contract with the exact provider filter enabled.

The official [model page](https://openrouter.ai/unbiased/pareto) owns public
metadata. Recheck it and the ordinary Router caller after endpoint changes.

## Validation

Follow the [common verification scope](architecture.md#verification). Use Pareto,
namespace-relay, compaction-checkpoint and empty-completion-guard tests for affected
behavior; a required full suite already includes them. Reuse unchanged source and
catalog checks.
[Dated investigation evidence](../history/2026-09-17-pareto.md) records the
bounded probes and is not live status. Keep scratch payloads under
`generated/pareto` with no credentials or private project-file contents.

Deployment and v2 certification are separate, explicitly authorized steps.
