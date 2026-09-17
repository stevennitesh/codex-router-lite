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
web search. It is published as v1 and has no active subagent certification.
The retired Union Alpha proof does not apply to this route.

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

Run the Pareto, namespace-relay, compaction-checkpoint, empty-completion-guard,
and retained suites, then `npm run check` and the current native catalog check.
[Dated investigation evidence](../history/2026-09-17-pareto.md) records the
bounded probes and is not live status. Keep scratch payloads under
`generated/pareto` with no credentials or private project-file contents.

Deployment and v2 certification are separate, explicitly authorized steps.
