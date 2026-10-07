# Route settings audit: 2026-10-07

Historical metadata and source verification, not current endpoint availability or
installed-runtime certification. Values below are tokens.

## External routes

Public model and exact endpoint metadata were fetched from OpenRouter. Provider
allowances, Router ceilings, defaults and compaction thresholds were checked
separately. A provider's model-wide aggregate is not authority for a pinned
endpoint's smaller limit.

| Route | Exact endpoint | Context | Compact at | Router output default | Router output ceiling | Endpoint output allowance |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| GLM StreamLake | `streamlake/fp8` | 1,024,000 | 880,000 | 128,000 | 128,000 | 128,000 |
| GLM Together | `together` | 1,048,575 | 900,000 | 128,000 | 128,000 | 943,717 |
| DeepSeek Together | `together` | 1,048,576 | 900,000 | 128,000 | 393,216 | 943,718 |
| DeepSeek DeepInfra | `deepinfra/fp8` | 1,048,576 | 900,000 | 128,000 | 131,072 | 131,072 |
| Pareto | `unbiased` | 262,144 | 220,000 | unspecified | 131,072 | 131,072 |

Together's large endpoint allowances do not by themselves prove model generation
limits. GLM retains a conservative 128,000 ceiling in line with Z.ai's 128K
model guidance. DeepSeek Together retains 393,216, converting the direct DeepSeek
API's documented 384K ceiling. No route ceiling was raised from aggregate
provider metadata alone. Pareto's default output budget is not published and
Router continues to leave it unspecified. A context ceiling must accommodate
the actual prompt plus generated tokens; an output ceiling is not a guarantee
of that allowance for an already-full prompt.

### Tools and other settings

| Route | Function choices | Reasoning default / levels | Sampling defaults |
| --- | --- | --- | --- |
| GLM StreamLake | automatic; `none` by withholding tools | max / low, high, max | temperature 1, top-p 0.95 |
| GLM Together | auto, none, required, named | max / low, high, max | temperature 1, top-p 0.95 |
| Both DeepSeek routes | auto, none, required, named | high / low, high, max | temperature 1, top-p 0.95 |
| Pareto | automatic; `none` by withholding tools | provider controlled | unspecified |

All exact endpoint tool-choice maps agree with the retained compatibility
flags. Each route omits unsupported `parallel_tool_calls` and preserves its
single provider pin, disabled fallback and required parameter support. Native
custom tools, namespaces and deferred discovery use Router's reversible function
bridge; they do not require the endpoint to advertise native Codex tools.

All five external routes advertise text/image input. Provider video capabilities
are not advertised to Codex without a supported client wire path. Only the GLM
routes advertise hosted web search: Exa fast, 5 results, 15 total results and
at most 3 uses/calls. Deferred tool discovery remains a separate capability on
all external routes. Reasoning summaries, verbosity, original image detail and
native live effort updates remain conservatively disabled on external entries.
Produced reasoning and tool-call history remain preserved by the existing
profile/translation owners; direct Z.ai or DeepSeek API flags are not added to
these reseller endpoints without a demonstrated matching wire contract.

## Native and Switchyard

All native entries were compared with their installed authoritative catalog.
Router preserved their metadata. No root context, compaction or output overrides
were found. Public API-model limits were not substituted for subscription-route
metadata. No native catalog entry exposed a numeric output-token ceiling, so this
audit makes no numeric native maximum-output claim.

| Native entry | Context | Maximum context | Default effort | Supported efforts |
| --- | ---: | ---: | --- | --- |
| GPT 6.1 Sol | 272,000 | 872,000 | low | low, medium, high, xhigh, max, ultra |
| GPT 6 Astra | 272,000 | 872,000 | medium | low, medium, high, xhigh, max, ultra |
| GPT 6 Sol | 272,000 | 872,000 | medium | low, medium, high, xhigh, max, ultra |
| GPT 6 Luna | 272,000 | 872,000 | medium | low, medium, high, xhigh, max |
| GPT Reserve | 272,000 | 872,000 | medium | low, medium, high, xhigh, max |
| GPT 5.6 Sol | 272,000 | 872,000 | low | low, medium, high, xhigh, max, ultra |
| GPT 5.6 Terra | 272,000 | 872,000 | medium | low, medium, high, xhigh, max, ultra |
| GPT 5.6 Luna | 272,000 | 872,000 | medium | low, medium, high, xhigh, max |
| GPT Daybreak Blue latest | 272,000 | 872,000 | low | low, medium, high, xhigh, max, ultra |
| GPT Daybreak Red latest | 372,000 | 372,000 | medium | low, medium, high, xhigh, max, ultra |
| GPT 5.5 | 272,000 | 272,000 | medium | low, medium, high, xhigh |
| Codex auto review | 272,000 | 872,000 | medium | low, medium, high, xhigh, max |

All accept text/image. Effective context is 95% where published; GPT Reserve
omits that field. Daybreak entries omit automatic-compaction metadata; the other
native entries publish null. Absence and null were preserved. Catalog entries
can remain hidden by picker settings or account visibility.

Switchyard derives common capabilities from its four native policy targets:
Luna Max, Sol Medium, Astra Medium and Astra XHigh. Its facade publishes a 272,000
context, 872,000 maximum, 95% effective context and null compaction metadata.
The static 244,800 compaction fallback in `auto.json` is not the published
threshold. Every target removes the external `max_output_tokens` hint, uses
streaming and `store: false`, and selects a supported effort. Experimental tools
and live effort updates are limited to the capabilities shared by all targets.
The optional worker description was corrected to include Astra.

## Repairs and verification

Two enforcement defects were repaired:

1. Pareto had no output ceiling in its record, and output validation returned
   early when a route lacked sampling defaults. It now declares 131,072, with
   explicit limits validated independently of sampling/default output policy.
2. Ordinary GLM/DeepSeek requests accepted unsupported reasoning efforts even
   though saved agent settings enforced the advertised vocabulary. Front and
   final preparation now reject unsupported effective efforts with HTTP 400 and
   `unsupported_reasoning_effort`. Scalar and translated-object forms and the
   primary reasoning object's precedence remain covered.

Authenticated final-boundary errors retain output/effort rejection codes while
provider-controlled imitations are not promoted to trusted local errors.
Regression coverage includes all three output aliases, boundaries at and above
the limit, invalid types, supported and unsupported efforts, unchanged original
inputs, actual HTTP rejection before dispatch and ordinary accepted HTTP calls
through every external route's configured transport.

The full source suite passed **497 tests**, with no skipped tests. Codex
0.162.0-alpha.2 parsed 17 candidate models. Separate installed-catalog inspection
covered 12 native entries and the six routed entries. Protected temporary fixture
cleanup required normal Windows user context; verification did not change
persistent sandbox settings or runtime files.

Independent review identified an alias-precedence regression in the new effort
validation: a primary reasoning object without an effort must still override the
translated alias. That was corrected and covered by a regression. All 11 affected
preparation/registry tests passed after the correction; final source checks also
passed. Other serving inputs stayed unchanged after the full-suite run.

No new provider inference calls were needed: the repaired cases fail locally,
and current exact-endpoint metadata plus the preceding actual tool/continuation
checks cover unchanged accepted settings. StreamLake's reproduced upstream
shared-pool 429 remains an availability limitation, documented in the
[capacity investigation](2026-10-07-streamlake-shared-capacity.md). This audit
does not establish successful generation at the numerical output maxima or
renew installed native collaboration proofs. The changes remain undeployed.

## Primary sources

- [GLM exact endpoints](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints)
- [DeepSeek exact endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints)
- [Pareto exact endpoint](https://openrouter.ai/api/v1/models/unbiased/pareto/endpoints)
- [OpenRouter model metadata](https://openrouter.ai/api/v1/models)
- [Z.ai GLM guide](https://docs.z.ai/guides/vlm/glm-5.3-flash)
- [DeepSeek direct API limits](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash)

Endpoint guides own maintained policy; this dated table records the audited
values and distinctions at the time of the investigation.
