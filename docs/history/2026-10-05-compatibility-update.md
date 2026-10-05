# Windows foreground startup and gateway compatibility - 2026-10-05

Historical source-update and isolated-integration evidence. This record does not
establish deployment acceptance or renew native route certification. Current
behavior and pins are owned by the maintained agent guides and source.

## Foreground startup

`model-router.ps1 codex start --foreground` previously imported `start.mjs`, which
unconditionally required a Windows managed process record. That record accepts
only the direct `src/start.mjs` process identity, so the foreground command failed
before starting Router. Original Router fix f35327d2 and test follow-up 9feb6289
(merge 564edd6a) supply the relevant launch-intent distinction.

The local foreground launcher now marks its intent before importing the supervisor.
The supervisor skips both publication and cleanup of a managed record for that
launch. It continues to hold the service-operation lock for its lifetime. Direct
managed startup still writes a verified record and refuses unknown or foreground
entrypoints; command-line inference does not decide whether verification applies.

The distinguishing Windows startup regression invokes the ordinary PowerShell
command, uses isolated state and a health-only gateway fixture, reaches Router
health, serves a synthetic native request and preserves a pre-existing process
record byte for byte. Both native-only and OpenRouter-selected cases pass. The
corresponding managed cases publish records that pass live ownership checks.
A separate regression refuses foreground and unexpected managed identities.

## Gateway dependency and accounting

LiteLLM moves from 1.103.0 to 1.104.0 in `requirements/python.in` and
`src/install-plan.mjs`. FastAPI stays at 0.141.1. Regenerating the Windows CPython
3.10 hash lock retained the other versions except the release's accompanying
`litellm-enterprise` 0.1.69 to 0.1.71 and `litellm-proxy-extras` 0.4.100 to
0.4.102.post1. The complete 118-package closure installed in an isolated Python
3.10.19 environment, passed dependency consistency, and passed pip-audit 2.10.1
with zero known vulnerabilities and no advisory suppressions.

The relevant [official release](https://github.com/BerriAI/litellm/releases/tag/v1.104.0)
includes [explicit-zero streamed usage handling](https://github.com/BerriAI/litellm/pull/42323)
and [clearing stale cache counts](https://github.com/BerriAI/litellm/pull/42330).
A deterministic local reproduction on the previous gateway returned 999 estimated
input tokens for a provider report of zero input and 17 output tokens. The same
reproduction on 1.104.0 preserves zero and 17. These helper observations made no
provider requests; acceptance also used the real proxy integration below.

The new gateway's master-key checks are compatible with the existing supervisor,
which supplies its protected random internal capability as `LITELLM_MASTER_KEY`.
The isolated qualification used a fresh random synthetic key and authenticated
gateway requests. No local token-accounting workaround or new runtime component
was needed. Release changes to database migration, UI/auth administration, and
other provider families do not add product capabilities.

[Sanitized qualification](2026-10-05-local-gateway-qualification.json) records
42 observations from 48 loopback mock provider requests through the actual
LiteLLM proxy, actual Router, and actual API forwarder on both exact GLM routes.
It covers Novita/GMICloud endpoint pinning and fallback prohibition, streamed and
non-streamed text/reasoning, reasoning replay, function and custom-tool history,
grammar conversion/restoration and continuation, Spaces namespace payload and tool
identity, cached usage, mixed stream ordering, whitespace, and provider 401/429.

Sixteen targeted streamed observations cover explicit zero input, zero output,
both zero, and clearing an earlier nonzero cached-token count, each with
choice-bearing and usage-only terminal chunks on each route. Client-visible
`response.completed` usage is checked directly. Both raw gateway diagnostics
had valid message-opening envelopes; existing GLM repair remains scoped to its
known malformed streams and passes its retained regressions.

## Codex compatibility

Current Windows app 26.930.4958.0 resolves signed CLI 0.160.0; bundled
`codex-app-tools` remains 0.1.5. The candidate's bundled-derived catalog parser
accepts 15 current-schema models and all retained route compatibility checks.
The earlier read-only installed-catalog inspection accepted 16 models. Those
catalog sources differ intentionally and neither result implies live native
collaboration acceptance.

The [official CLI release](https://github.com/openai/codex/releases/tag/rust-v0.160.0),
published October 1, was inspected for catalog, tools and Windows changes.
Relevant changes include authoritative explicit provider catalogs and rejection of
stale fallback catalogs (#49135), preserving pending child environments and
surfacing preparation errors (#49075), Windows PowerShell/long-path ACL/helper
console fixes (#49019, #49058, #49098, #49164, #49386), opt-in Guardian handoff
history (#49036, #49057, #49038), and plugin manifest/pool caching (#49099, #49100).
Current native catalog authority and request-local tool definitions already fit
these changes. Windows host repairs ship in the CLI; no additional Router port
was identified. No specific public notes for this exact Desktop patch were verified.
The fetched Desktop changelog was incomplete for this release, so search snippets
were not used to assert patch behavior.

Fresh encrypted native assignments and ordinary native routed tool calls were
outside this qualification's quota boundary. Existing four-route exact-runtime
proofs name older identities and are not renewed by source, catalog or mock tests.

## Complete upstream disposition

The [review matrix](2026-10-05-compatibility-review.json) accounts individually for
all 52 Original Router commits after
`0a70b48c0ed7039034d097b4fd6a0e7e1e969143` through
`85259b6725ced1c1f0f56325b0c97a7b6660a726`, including merge commits. Titles,
stats and retained-owner diffs were inspected during the current review.
Only the foreground repair was ported. The complete-line WebSocket SSE bound
from 1972ac43 is already covered locally, including partial, CRLF and EOF cases.
Reasoning replay changes target a retired local owner now owned by LiteLLM;
automatic child close changes target a retired owner and conflict with caller
lifecycle ownership. Generic Responses handoffs, direct Z.ai coding deadlines,
multi-client publication and billed-retry UI changes fall outside retained routes.
Other changes target Ollama, Grok, MiniMax, vision downloads, generic registries,
tray/UI, macOS/POSIX, upstream fixtures/docs or merge synchronization.

The Router review baseline advances to that completely dispositioned head.
Previous deferred candidates remain recorded without promotion or removal.
No upstream merge was performed.

Switchyard remains pinned to `fbabf51c62793ed0f6af042b60e92ce1cfba083b` with
configuration and binary unchanged. Observed upstream head
`c8848511a7e2e1d605070c7a68905bdc24c6481a` is unchanged since the October 3 review.
The matrix records all 17 commits after the pin. Decision/capability and
plan-execute classifiers, mixed OpenAI/Anthropic gateways, translation and Linux
changes supply no required repair for the private native Responses TypeSafeJev
1.13 route. The contribution patch still conflicts in runner algorithm imports
and `docs/reference/toml_schema.md`; the compatibility layer was not checked
without its required input layer. A future pin update requires deliberate ordered
patch rebasing, build and runtime qualification, including the Rust 1.99 transition.

## Verification and remaining boundaries

- Focused startup/identity tests: 8 passed, zero failures or skips.
- `npm run check`: pins, hash lock, product boundary, applications and syntax passed.
- `npm test`: 363 passed, zero failures or skips, with Windows owner-context probes.
- Current Codex catalog parser: passed for 15 bundled-derived models.
- Production Node audit: zero findings.
- Complete hash-locked Python closure audit and dependency consistency: passed.
- Actual isolated gateway integration: 42 observations passed on both GLM routes.

Source base was `4900ea3b7688e87b38fcf131ef6f08effe4a8e75`. No live service process, state or Python environment was changed. Local candidate
checks do not prove source/runtime alignment for an already running supervisor. No live
OpenRouter/ChatGPT request, native route certification, deployment, service restart,
commit, push or PR creation was performed. Local fixtures establish application
integration and the changed gateway behavior; live provider behavior and native
assignment/tool compatibility on this app build remain unverified.
