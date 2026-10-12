# Models and routes

Codex Router Lite gives each model and provider endpoint its own picker entry.
This pairing is called a **route**. The OpenRouter routes below use one fixed
endpoint each, with provider fallback disabled.

| Model ID | Model and provider | Maintained details |
| --- | --- | --- |
| `openrouter/glm-5.3-flash-streamlake` | GLM-5.3-Flash through OpenRouter / StreamLake FP8 | [GLM compatibility](agents/openrouter-glm.md) |
| `openrouter/glm-5.3-flash-together` | GLM-5.3-Flash through OpenRouter / Together | [GLM compatibility](agents/openrouter-glm.md) |
| `openrouter/deepseek-v4.1-flash-together` | DeepSeek V4.1 Flash through OpenRouter / Together | [DeepSeek compatibility](agents/openrouter-deepseek.md) |
| `openrouter/deepseek-v4.1-flash-deepinfra` | DeepSeek V4.1 Flash through OpenRouter / DeepInfra FP8 | [DeepSeek compatibility](agents/openrouter-deepseek.md) |
| `openrouter/pareto` | Pareto through OpenRouter / Unbiased | [Pareto compatibility](agents/pareto.md) |
| `switchyard/auto` | Automatically selects a native GPT model and reasoning effort | [Routing policy](../config/switchyard/README.md#routing-policy) |

GLM supports provider web search and a selectable reasoning effort. StreamLake
supports automatic tool selection; Together also supports forced tool calls.
DeepSeek uses direct Responses with low/high/max reasoning, plus function and
custom tools. Its routes do not provide hosted web search. Pareto controls its
own reasoning and decides when to call tools; its route has no provider web
search. Connected app tools depend on what Codex supplies to the chat.

Switchyard uses OpenRouter's Jev model to select a native GPT model and reasoning
effort. The selected GPT model produces the answer through the user's Codex
account. It needs an OpenRouter key for those decisions and the separate
[build and deployment](../config/switchyard/maintenance.md).

Configuration lives in [OpenRouter route files](../config/openrouter/) and
[Switchyard configuration](../config/switchyard/). The
[model registry](../src/routed-models.mjs) defines public model entries.

## External subagents

Certified external routes are available as subagents by default. Local settings
can restrict which eligible routes Codex may select. Run from the repository root:

```powershell
.\model-router.ps1 codex subagents status
```

[Certification requirements](SUBAGENT-CERTIFICATION.md) define the checks for a
new route. The [application index](../v2_agent/README.md) retains evidence for
the exact runtimes tested. A published historical proof does not certify every
later installation, model change or execution surface.

## Add a model or endpoint

Use [model onboarding](agents/model-onboarding.md) to define an endpoint, adapt
request and tool representations, and verify the ordinary Codex path. An
OpenAI-compatible API can still need changes for Codex tools, history and
streaming. [Request preparation](agents/request-preparation.md) explains that
translation; the [architecture](agents/architecture.md) identifies source owners.
