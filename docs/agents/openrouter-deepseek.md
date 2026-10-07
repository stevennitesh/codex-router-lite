# OpenRouter DeepSeek V4.1 Flash

Read this for the two explicitly selected DeepSeek routes. The common procedure
is [model onboarding](model-onboarding.md); native child eligibility is owned by
[certification](../SUBAGENT-CERTIFICATION.md).

| Public slug | Exact endpoint | Context | Maximum output |
| --- | --- | ---: | ---: |
| `openrouter/deepseek-v4.1-flash-together` | `together` | 1,048,576 | 393,216 |
| `openrouter/deepseek-v4.1-flash-deepinfra` | `deepinfra/fp8` | 1,048,576 | 131,072 |

Fallback is disabled and parameter support is required. The `/fp8` suffix pins
DeepInfra's endpoint variant. The Together output cap uses the model's published
limit; OpenRouter reports a larger endpoint allowance, which is not evidence that
the model can produce that many tokens.

## Request contract

Both routes use the `deepseek-v4.1-flash` profile and direct OpenRouter Responses.
Keep produced reasoning items intact across tool calls and replay. The ordinary
preparer handles namespaces, deferred discovery and custom tools; custom tools
are converted to functions and restored with their original identity and payload.
Compaction sends no tools and preserves readable history through the same profile.

The default reasoning effort is `high`; callers may select `low`, `high` or `max`.
Sampling defaults are temperature 1 and top-p 0.95. Caller settings take precedence.
The default output allowance is 128,000 tokens, including reasoning. Compaction
starts at 900,000 tokens, leaving room for that allowance. Explicit output limits
above the route's cap are rejected locally rather than silently reduced.

Automatic, required and named function choices passed exact endpoint probes.
Neither endpoint accepts `parallel_tool_calls` with required parameter support;
omit that optional scheduling hint. Neither route advertises provider-hosted web
search. Native deferred tool search is a separate client capability.

Direct DeepSeek API workarounds do not automatically apply to these reseller
endpoints. Do not import reasoning placeholders, forced-choice downgrades or a
provider-specific prompt encoder without a reproduced defect through this path.
The [dated research](../history/2026-10-06-openrouter-route-refresh.md) records
sources, probes and the upstream comparison. Exact native proof remains draft
until all five certification checks pass.
