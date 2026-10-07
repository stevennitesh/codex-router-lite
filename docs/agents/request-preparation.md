# Request preparation ownership

`src/routed-request.mjs` owns external request preparation. Ordinary turns and
compaction call `prepareRoutedRequest`; the result contains the provider payload,
transport choice, search mode, and the namespace context needed to restore the
response. These values belong to one request and must travel together.

Every external route declares its output ceiling. Explicit output aliases
(`max_output_tokens`, `max_tokens`, `max_completion_tokens`) are validated at
front preparation and final provider preparation. Output validation is independent
of whether a route defines sampling or an implicit output default. Explicit
reasoning efforts use the registry's advertised vocabulary. Provider-controlled
Pareto reasoning is removed by its adapter before that validation.

## Owners

| Concern | Owner |
| --- | --- |
| Retained model registration, config loading, profile-to-transport mapping | `src/routed-models.mjs` |
| Capabilities, exact endpoint restrictions, limits | `config/openrouter/*.json` and their registry validation |
| Preparation order, ordinary/compaction differences | `src/routed-request.mjs` |
| Tool identity, discovery, custom call conversion, streaming restoration | `src/namespace-relay.mjs` |
| Pareto parameter restrictions | `src/pareto-compat.mjs` |
| Endpoint tool-choice restrictions, sampling and output defaults | `src/openrouter-endpoint-compat.mjs` |
| Hosted-search conversion and bounds | `src/openrouter-hosted-search.mjs` and `src/search-capability.mjs` |
| Native authentication, encrypted handoff resolution, HTTP lifecycle, retries | `src/router.mjs` and its existing transport helpers |
| Final outbound payload and endpoint policy | `src/openrouter-request.mjs` |
| Protected OpenRouter credential, cancellation and HTTP forwarding | `src/api-forwarder.mjs` |
| Source extraction and checkpoint representation | `src/compaction-checkpoint.mjs` |

The preparer has no network or persistent state and receives no credentials.
Native GPT and Switchyard requests bypass it. It rejects the native profile
rather than translating native requests through external-provider rules.

## Shared flow and deliberate differences

Preparation normalizes standalone app results, constructs the current tool
surface, resolves discovery history, translates names and choices, applies the
selected route's custom-history and parameter rules, and chooses the transport.
Response restoration uses the returned namespace context, not a rebuilt map.

`src/tool-schema-root.mjs` owns provider-facing schema normalization for current
and discovered function declarations, including client tool search. It aligns
contradictory enum/const literals with their own declared type and makes eligible
object union roots explicit with `type: "object"`. Root `anyOf`, `oneOf`, and
`allOf` constraints, local references, definitions, branch discriminators,
required fields, and property shapes remain intact. It does not merge branches
or reconstruct arguments. The caller's original declaration remains unchanged.

Object eligibility comes from an object type, a type array containing object,
or properties on an untyped schema, including through bounded local `$ref`
inspection. Explicit root types excluding object, primitive-only unions, and
unresolved unions remain unchanged. Existing nullable-object root narrowing
retains other constraints and aligns root enum/const literals with the resulting
object type after promotion or narrowing. Ordinary object schemas retain identity
when no literal normalization is needed. This shared external preparation applies to
both GLM chat routes, DeepSeek, Pareto, and ordinary functions alongside GLM hosted search;
native and Switchyard-selected native requests bypass it.

Flattened external function declarations carry the provider schema once, in
`parameters`. The provider-facing copy omits Codex's `inputSchema`; the original
native declaration remains unchanged, including the schema used for request-local
subagent-model constraints and discovery. Both direct Responses endpoints and the
GLM adapter consume `parameters`.

The pinned LiteLLM adapter preserves these unions beneath an object root on
the configured custom OpenAI-compatible loopback hop. Offline adapter and schema
checks prove preservation through local preparation; they do not establish live
endpoint acceptance or model argument reliability.

For example, one call returns a single request-local bundle:

```js
const prepared = prepareRoutedRequest(clientPayload, route);
const upstream = await send(prepared.transport, prepared.payload);
return restoreProviderResponse(upstream, prepared.namespaces);
```

The exact response helper varies by transport; the invariant is that
`prepared.namespaces` from this preparation call accompanies its response.

Compaction recovers historical definitions solely to translate history. It sends
no tools or tool choice, removes previous-response references, appends the source
catalog and summary instructions, and uses non-streaming Responses. GLM reasoning
replay belongs to the pinned LiteLLM bridge described in the
[GLM guide](openrouter-glm.md); the preparer has no separate reasoning-carry shim.
Pareto and DeepSeek's custom-tool bridge and historical-name aliasing apply to both paths. GLM hosted
search uses the direct Responses hop; ordinary GLM requests still use LiteLLM.

The forwarder calls `prepareOpenRouterRequest` for final payload validation and
Pareto and endpoint parameter filtering at the external send boundary. This is intentional:
internal callers can reach the
forwarder directly, so validation only in the front Router would be bypassable.

For completed request bodies above 1 MiB, the forwarder yields before parsing and
before serialization. The front Router also yields between external preparation
and serialization when the decoded body exceeds 1 MiB, including compressed and
chunked callers. This lets concurrent loopback requests progress between large
synchronous JSON stages. Each hop rechecks caller cancellation after yielding;
authentication, final payload validation, and endpoint restrictions still precede
the external send. Smaller requests do not incur these scheduling turns.

## Design decisions

One owner assembles ordinary and compaction requests. Profiles are explicit;
there is no dynamic plugin system or generic hook pipeline.
Splitting the namespace stream parser merely by file size would spread its
identity and partial-stream state across owners, so it remains cohesive.

Model registrations derive their `config/<slug>.json` paths and expected profile
map from one list. Profile transport and endpoint validators are paired in
that registry; identities are checked before lookup maps are constructed. Product-boundary checks and the Windows package manifest stay
independent: they verify the approved product and installed files rather than
accepting whatever the runtime registry happens to load.

For a preparation refactor, compare provider payloads, transport choice and restored
identities against the prior behavior. Preserve catalog, transcript and checkpoint
contracts unless changing them is part of the task. Follow the common
[verification requirements](architecture.md#verification); deployment and runtime-bound
certification remain separate from source-level verification.
