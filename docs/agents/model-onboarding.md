# Add or change a model or endpoint

Start with [architecture](architecture.md) when unfamiliar with the Router.
This guide covers an authorized addition or endpoint change, not a general
provider-discovery system. Preserve every existing route's behavior.

## Establish the endpoint contract

Identify the public Router slug, upstream model, exact provider endpoint and wire
API. For OpenRouter keep a single endpoint with fallback disabled and required
parameter support. A second endpoint is a separate explicit route, not a fallback.
Check current official metadata and synthetic requests; model self-identification,
tokenizer clues and another provider's success do not establish compatibility.

Measure the capabilities the native caller needs: text/images, reasoning controls,
streamed events, tool declarations and choices, tool-result replay, deferred discovery,
custom tools, compaction and continuation. Hosted web search and native deferred
tool search are separate capabilities. Start with no unsupported catalog claim.

Choose an existing request profile only when its wire contract matches. A model
family guess is insufficient. Prefer direct Responses when it preserves the needed
native contract; use the existing translation path when the endpoint requires it.
If a new profile is needed, own its measured differences at the preparation or
response boundary that requires them, not as scattered slug checks.

## Change the owning surfaces

| Change | Owner and condition |
| --- | --- |
| Public metadata, limits, effort, modalities, endpoint policy | `config/openrouter/<model>.json`; reuse an existing provider record |
| Registration, profile, transport, exact-route validation | `src/routed-models.mjs`; register its transport/validator together; reject duplicate slugs or gateway IDs |
| Request/history conversion | `src/routed-request.mjs`; [preparation contract](request-preparation.md) |
| Provider send boundary | `src/openrouter-request.mjs` for payload policy, `src/api-forwarder.mjs` for transport; preserve exact policy and credential isolation even for internal callers |
| Chat translation | `src/litellm-config.mjs` only for chat profiles; [GLM/Python guide](openrouter-glm.md) if that path changes |
| Response event repair | Existing transform owner, only if a reproduced wire defect requires it; keep request-local restoration paired |
| Catalog behavior | `src/catalog.mjs` and catalog tests if existing metadata cannot express it; inherit native fields rather than copy a catalog |
| Installed files and product allowlist | `maintenance/windows-package.json`, `scripts/check-product-boundary.mjs`; include new runtime files and config, retain independent checks |
| Tests and public guidance | Endpoint regression, routing/catalog coverage, README model list and a focused endpoint guide |
| Subagent eligibility | Leave uncertified routes at v1; load [certification](../SUBAGENT-CERTIFICATION.md) only when claiming v2 |

Existing contracts: [GLM](openrouter-glm.md), [Pareto](pareto.md), and
[Switchyard](../../config/switchyard/README.md). Read only the one being reused
or changed. Their provider-specific repairs are not default settings for a new model.

## Prove the ordinary path

Run the [source checks](architecture.md#verification). Verify the actual Router
caller, not just a successful direct endpoint request. Cover a tool call and its
produced result history, namespace collisions, supported tool choices, and compaction
followed by resume. For shared transforms include an existing unaffected route and
native bypass. Preserve cancellation, partial/error events and truncated calls;
never make a failed execution look like a successful final answer.

Use synthetic payloads and the protected credential store. Keep captures under
`generated/`, redact sensitive fields, and respect authorization for quota and
external payload transmission. Record observations and unresolved limitations in
[dated history](../history/README.md); keep the endpoint guide about maintained rules.

Source acceptance, deployment and certification are distinct. For authorized live
replacement follow [installation](../INSTALL.md), then verify installed hashes and
ordinary routed behavior. Refresh exact-route proofs when their bound behavior changes.
