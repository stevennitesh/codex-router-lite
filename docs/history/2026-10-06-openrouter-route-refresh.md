# OpenRouter endpoint refresh: 2026-10-06

This change replaces Novita with the explicit StreamLake GLM slug, replaces
the GMICloud slug with an explicit Together slug, and adds DeepSeek V4.1 Flash on
Together and DeepInfra. Each route pins one endpoint with fallback disabled.
Earlier Novita and GMICloud native proofs do not certify these endpoints.

## Settings and sources

The [OpenRouter GLM endpoint API](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints)
reports StreamLake FP8 with a 1,024,000-token context and 128,000-token output limit;
Together reports a 1,048,575-token context. The
[Z.ai GLM guide](https://docs.z.ai/guides/vlm/glm-5.3-flash) recommends maximum
reasoning, temperature 1 and top-p 0.95, with a 128K model output limit. Both GLM
routes use those defaults. StreamLake compacts at 880,000; Together at 900,000.

The [DeepSeek model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)
recommends temperature 1 and top-p 0.95 or 1. The
[OpenRouter model metadata](https://openrouter.ai/api/v1/models) advertises
low/high/max reasoning, default high, and a 393,216-token model output limit.
The [DeepSeek endpoint API](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)
reports a 1,048,576-token context for both selected routes and 131,072 output
tokens on DeepInfra FP8. Together's much larger endpoint allowance is capped at
the model limit. These routes default to high reasoning, temperature 1, top-p
0.95 and 128,000 output tokens; they compact at 900,000. These are documented
operating defaults, not a comparative speed or quality benchmark.

The [OpenRouter provider selection guide](https://openrouter.ai/docs/guides/routing/provider-selection)
distinguishes base provider slugs from variant tags. Use `streamlake/fp8` and
`deepinfra/fp8` to pin the measured variants. The
[reasoning guide](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
requires preserving reasoning across tool exchanges. DeepSeek's direct Responses
path retains actual produced items without a Responses-to-chat translation.

## Measured endpoint differences

Synthetic requests through the protected OpenRouter credential produced these
results; captures remain ignored under `generated/openrouter-route-refresh/`.

| Check | StreamLake GLM | Together GLM | Together DeepSeek | DeepInfra DeepSeek |
| --- | --- | --- | --- | --- |
| Automatic function call with root object union | pass | pass | pass | pass |
| Actual produced reasoning/tool history and result | pass with tools omitted | pass | pass | pass |
| Named function choice | rejected upstream | pass | pass | pass |
| Required function choice | unsupported by auto-only contract | pass | pass | pass |
| `parallel_tool_calls` | rejected upstream | rejected upstream | rejected upstream | rejected upstream |

StreamLake rejects literal `none` and named choices. Omitting available tools
implements `none` without changing it to automatic selection. Forced choices
fail locally with `unsupported_tool_choice`; no provider fallback or downgrade
is used. All four omit the unsupported parallel scheduling control.

The ordinary Router caller then passed 40 bounded checks across the four routes:
streamed completion, image input, colliding namespace identities with root unions,
actual produced reasoning/tool-result replay, grammar custom calls and replay,
deferred discovery, compaction and checkpoint resume, and supported forced choices
or local rejection. Captures remain ignored; the installed service was untouched.

The first grammar check failed when GLM copied a grammar production into its
input. The pinned gateway had described the grammar as a format. Reusing Router's
existing reversible custom-tool bridge states that the input must parse against
the grammar. The subsequent ordinary-path run returned the exact legal input and
continued from its actual output on all four routes. No model output is rewritten
to disguise an invalid tool payload.

Four final synthetic requests also captured the actual outbound settings after
translation. All four sent temperature 1, top-p 0.95 and their configured effort
(GLM max, DeepSeek high). Defaults are applied before translation as well as at
the final send boundary, so gateway defaults cannot replace an omitted caller
setting. The full suite passed 376 tests and CLI 0.162.0-alpha.2 parsed all six
candidate routed models using its current catalog schema.

Both replacement GLM endpoints also passed one ordinary hosted-search request:
each returned a restored `web_search_call`, the requested answer marker and
`server_tool_use_details.web_search_requests = 1`. StreamLake used automatic
selection. These checks sent only a public query for Python's documentation site.

These checks do not establish native subagent eligibility. The applications remain
draft/v1 pending the authorized deployed native certification window.

## Upstream review

Reviewed Router upstream `053f1b741dc89cc5b684b4df2e885cefcbdfabc7`, including its
[DeepSeek OpenRouter route](https://github.com/duolahypercho/codex-router/blob/053f1b741dc89cc5b684b4df2e885cefcbdfabc7/config/openrouter/deepseek-v4.1-flash.json)
and direct DeepSeek Responses repairs. Its OpenRouter route uses automatic tool
choice without pinning these endpoints. Our measured Together and DeepInfra
routes support forced choices, so that restriction is not adopted.

The upstream direct DeepSeek adapter repairs direct API reasoning replay and
normalizes unsupported forced choices. Those repairs target a different provider
and wire contract. Produced reasoning replay already succeeds on both selected
OpenRouter endpoints; no placeholder reasoning or direct-provider adapter is
needed. Existing LiteLLM remains the GLM translation owner; no dependency upgrade
is required for the direct DeepSeek path.
