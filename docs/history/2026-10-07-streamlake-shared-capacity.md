# StreamLake shared-capacity refusal: 2026-10-07

Historical diagnosis, not current availability or certification authority.

The preceding latency checks recorded HTTP 429 for
`openrouter/glm-5.3-flash-streamlake`, but intentionally discarded the refusal
body. That status alone did not establish the cause.

## Decisive checks

Two new synthetic inference requests were made without fallback or automatic
429 retries:

1. Direct official OpenRouter Chat Completions, upstream
   `z-ai/glm-5.3-flash`, `order` and `only` set to `streamlake/fp8`,
   `allow_fallbacks: false`, `require_parameters: true`. One automatic function,
   low reasoning, 2,048 output tokens, temperature 1 and top-p 0.95. HTTP 429
   carried `provider_name: StreamLake`, `is_byok: false`, and
   `limit_source: upstream_provider_shared_pool`. The provider detail explicitly
   reported temporary upstream rate limiting. No `Retry-After` was returned.
2. The same kind of tool request through an isolated current Router, real pinned
   LiteLLM gateway and credential-owning forwarder, with the official OpenRouter
   base explicitly set. HTTP 429 was preserved; no tool call or continuation was
   produced. LiteLLM's translated message retained only `Provider returned error`
   and wrapper text, omitting the useful shared-pool metadata.

Read-only key status returned HTTP 200, a paid account and non-exhausted key
quota. Public endpoint metadata still listed the exact StreamLake FP8 variant,
the requested parameters and the configured context/output limits. Independent
code inspection found no endpoint, supported-setting or retry-policy defect.

Together and other routes' preceding successes were supporting context, not the
decisive evidence. The direct StreamLake refusal establishes that bypassing
Router cannot resolve the reproduced failure. This does not establish the
provider's precise RPM/TPM limit, broader outage scope or recovery time.

## Resolution boundary

No local serving/configuration change was warranted. OpenRouter/StreamLake must
restore or increase the shared provider capacity. A supported provider-key
integration may use separate account limits, but StreamLake eligibility and
account capacity were not verified and no account settings were changed.
Selecting Together explicitly is a temporary operating option, not a repair to
StreamLake. The pinned endpoint, fallback prohibition and refusal status remain.

The investigation stopped after the attributable refusals. It did not renew a
native proof or deploy a candidate. Protected credentials stayed in process;
provider/account identifiers were removed from retained diagnostics. Disposable
services and state were cleaned up. Local sanitized probes and results remain
ignored under `generated/streamlake-diagnosis/`.

Maintained operating guidance: [Troubleshooting](../TROUBLESHOOTING.md#streamlake-returns-429).
Source for provider-key behavior: [OpenRouter BYOK](https://openrouter.ai/docs/guides/overview/auth/byok).
