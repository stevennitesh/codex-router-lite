# Request preparation ownership

`src/routed-request.mjs` owns external request preparation. Ordinary turns and
compaction call `prepareRoutedRequest`; the result contains the provider payload,
transport choice, search mode, and the namespace context needed to restore the
response. These values belong to one request and must travel together.

## Owners

| Concern | Owner |
| --- | --- |
| Retained model registration, config loading, profile-to-transport mapping | `src/routed-models.mjs` |
| Capabilities, exact endpoint restrictions, limits | `config/openrouter/*.json` and their registry validation |
| Preparation order, ordinary/compaction differences | `src/routed-request.mjs` |
| Tool identity, discovery, custom call conversion, streaming restoration | `src/namespace-relay.mjs` |
| Pareto parameter restrictions | `src/pareto-compat.mjs` |
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

Compaction recovers historical definitions solely to translate history. It sends
no tools or tool choice, removes previous-response references, appends the source
catalog and summary instructions, and uses non-streaming Responses. GLM thinking
carry is an ordinary-turn adaptation, not a compaction adaptation. Pareto's
custom-tool bridge and historical-name aliasing apply to both paths. GLM hosted
search uses the direct Responses hop; ordinary GLM requests still use LiteLLM.

The forwarder calls `prepareOpenRouterRequest` for final payload validation and
Pareto parameter filtering at
the external send boundary. This is intentional: internal callers can reach the
forwarder directly, so validation only in the front Router would be bypassable.

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
