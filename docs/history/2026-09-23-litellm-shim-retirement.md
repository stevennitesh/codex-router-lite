# LiteLLM 1.102.1 shim retirement audit - 2026-09-23

Historical compatibility evidence, not live deployment status. The maintained
GLM contract lives in `docs/agents/openrouter-glm.md`.

## Scope

This audit re-ran Router Lite's LiteLLM-specific workarounds against the exact
pinned LiteLLM 1.102.1 package in a disposable Windows CPython 3.10.19
environment. A local fake OpenAI-compatible upstream exercised the raw
Responses-to-Chat bridge without Router response transforms.

The exact upstream tag is LiteLLM `v1.102.1`, commit
`d09bbae1c6df463e425558f60d460437193635da`.

## Retired workarounds

Three compatibility behaviors are now owned by LiteLLM 1.102.1 and were removed
from Router Lite:

1. **Reasoning-history carry-forward.** LiteLLM now calls its bridge with
   `replay_reasoning=true` and reconstructs prior Responses reasoning as
   assistant `reasoning_content`. The raw probe verified both a reasoning +
   assistant-answer history and a reasoning + function-call + tool-result
   history.
2. **Choice-bearing cache-usage normalization.** LiteLLM now consumes terminal
   Chat Completions chunks that contain both `choices` and `usage`, and
   emits Responses usage with `input_tokens_details.cached_tokens` intact.
   Router Lite no longer rewrites the provider SSE stream before LiteLLM.
3. **Reasoning/message duplicate-ID repair.** 1.102.1 synthesizes distinct
   `rs_...` and `msg_...` identities in the reproduced reasoning-to-text
   stream, so Router Lite no longer invents replacement message IDs.

## Retained workarounds

The GLM Responses envelope transform remains necessary. The same raw 1.102.1
probe still reproduced all of the following:

- visible `response.output_text.delta` after reasoning without a preceding
  message `response.output_item.added`;
- no corresponding `response.content_part.added` before that text;
- a visible-text close represented as a `reasoning_text` content part; and
- a function-call output item opened and completed while the assistant message
  output item was still open.

Those are wire-lifecycle defects relative to the Codex Responses contract, so
`src/zai-responses-compat.mjs` remains, narrowed to envelope sanitization and
output-item ordering.

The empty-tool check in the final OpenRouter boundary also remains. LiteLLM
1.102.1 omits `tools: []` itself on ordinary GLM traffic, but the final
boundary additionally serves direct internal Responses routes and rejects an
impossible forced tool choice with no declared tools.

LiteLLM's custom-tool conversion is now explicitly treated as the GLM owner.
Router Lite retains its custom-tool machinery only where it provides broader
product behavior: namespace/collision restoration and Pareto's direct Responses
compatibility.

No real provider endpoint or billable model request was used in this audit.
