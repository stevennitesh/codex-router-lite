# Tool union preservation investigation, 2026-10-05

This source investigation used synthetic declarations and no live provider
requests, private conversations, deployment changes, or certification updates.
The starting source was `c187f1428b03eba1b7ae1c7bed9606bf575857c0`.

The former `src/tool-schema-root.mjs` branch merge kept the first duplicate
property, intersected required lists for `oneOf`, `anyOf`, and `allOf`, discarded
branch relationships, and opened additional properties. A four-mode synthetic
contract reduced to `mode: const create`: legal update/view/delete calls were
no longer represented, while missing create requirements, incompatible branch
fields, and undeclared fields were advertised as valid. An `allOf` also lost
a conjunct's required field. This establishes declaration loss; it does not
attribute historical model argument failures to Router.

The source repair preserves the original root combinators under an explicit
object type when object evidence exists. Local references are inspected only
for eligibility and remain intact in the output. Primitive-only, explicitly
nonobject, and unresolved unions retain their declaration. Nullable-object
narrowing and contradictory literal normalization retain their existing scope.
The maintained behavior owner is [request preparation](../agents/request-preparation.md).

The checked local `.venv` contained LiteLLM 1.104.0. Its Responses-to-chat
adapter preserves root combinators and adds an object type when type is absent.
Router configures the gateway as `openai` with a custom loopback API base;
that chat transform preserves combinators and applies regex cleanup, while
its combinator flattening applies to OpenAI-hosted endpoints. Synthetic probes
used the actual repaired Router payload, pinned adapter, configured chat
transform, final OpenRouter preparation, and independent JSON Schema validation.
They also checked Pareto and GLM hosted-search direct preparation.

Durable regressions cover modes and branch constraints, allOf conjunction,
different duplicate-property types, root constraints, local references,
current/plain/tool-search/discovered entrypoints, immutability, and legal-call
identity/argument restoration and replay. Existing native/Switchyard paths and
deployment-bound v2 proofs remain outside this source repair.

Verification on the first source candidate: the six new regression tests failed against
the former schema module loaded from the starting commit and passed with the
repair. The affected preparation/relay tests passed 37/37; `npm run check` passed;
the full `npm test` passed 369/369. The initial sandboxed full run could not create
the isolated WMI test worker; the supported escalated rerun passed all tests without
touching the installed service. The resolved Codex CLI 0.160.0 parsed 15 current
schema models and passed GLM, Pareto, and Switchyard catalog compatibility.
Independent JSON Schema checks retained every legal mode and rejected missing
requirements, incompatible combinations, undeclared fields, and a missing allOf
conjunct. Both actual GLM payloads retained the complete union through the pinned
adapter, configured chat transform, and final provider preparation.

Lead review R1 found that root promotion followed literal normalization, allowing
the newly object-typed root to retain null or primitive enum/const values. The
successor runs the existing literal normalization policy after promotion/narrowing.
A paired nullable-versus-explicit-object regression fails with the pre-R1 return
sites and passes with the correction; the untyped object union keeps its branches
while filtering incompatible root literals. Original declarations remain unchanged.
Affected checks passed 38/38, `npm run check` passed, and the full suite passed
370/370 with the established fixture-safe escalation. The first successor full
run saw one encrypted-agent relay fixture return 502; its exact isolated check
and the full rerun passed without source changes to that path. No cause is assigned
to that nonrecurring observation. Independent JSON Schema checks across both GLM
routes and Pareto showed matching legal-object and rejected-object constraints
for nullable/promoted roots and their explicit-object equivalents. The prior
unchanged catalog compatibility proof was reused.

Local preservation does not prove live Novita/GMICloud/Unbiased schema keyword
acceptance or improved model reliability. No live endpoint acceptance is claimed.
