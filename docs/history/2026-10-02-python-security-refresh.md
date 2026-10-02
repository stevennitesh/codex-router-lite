# Python security and gateway refresh - 2026-10-02

Historical source-update evidence, not live deployment or native certification.
Current dependency authority is `requirements/python.in`,
`requirements/python.txt`, and `src/install-plan.mjs`.

## Dependency changes

LiteLLM moves from 1.102.1 to 1.103.0 in both direct-pin owners. FastAPI stays
at 0.141.1. The Windows CPython 3.10 hash lock was regenerated, including:

- PyJWT 2.13.0 to 2.15.1;
- urllib3 2.7.0 to 2.8.0; and
- OAuthlib 3.3.1 to 4.0.0.

The prior lock had 18 open dependency alerts: one critical, seven high, and ten
medium. The complete updated production closure passes pip-audit 2.10.1 with
no known vulnerabilities and no advisory suppressions. This establishes a
clean dependency audit; it does not establish that every prior advisory was
exploitable through Router Lite.

Dependabot PR 24 was reviewed as input. Its lock kept the three affected
transitive versions and omitted the matching installer pin. This update repairs
both owners and regenerates the lock instead of merging that incomplete candidate.
The obsolete FastAPI 0.139.2 qualification comment was also removed from the
installer owner; its actual retained pin is 0.141.1.

## Real gateway qualification

The exact hashed closure installed into a disposable Windows CPython 3.10.19
environment. Its 118 installed distributions passed the environment's dependency
consistency check. The real LiteLLM proxy, Router and API forwarder were exercised
against a loopback mock OpenRouter service using synthetic credentials and history.
No live provider request or provider quota was used.

[Sanitized qualification](2026-10-02-local-gateway-qualification.json) records
22 observations across both Novita and GMICloud routes, using 26 local mock
provider requests. They verify endpoint and fallback policy, ordinary text,
reasoning/text streaming, reasoning history, function and custom-tool calls and
result continuation, cached-input usage, mixed stream item ordering, and original
upstream 401/429 statuses. Text split across `version `, `2`, and ` is ready`
preserved the exact spaces in the produced client text.

The raw gateway streams tested here had message opening envelopes. The existing
GLM envelope repair remains scoped to malformed input and passes its retained
regressions; this bounded qualification does not establish that all live-provider
stream shapes are valid.

## App and upstream disposition

Windows app 26.930.2377.0 bundles signed OpenAI CLI 0.159.0-alpha.12.1. Bundled
app-tools remains 0.1.5. The installed managed catalog parses all 16 models.
The previous exact-route native proof names a different app/CLI build and is
not renewed by local synthetic qualification.

Original-Router commits 0c59050c and merge 0a70b48c only update its Control Center
and docs-site dependency locks. Neither is shipped by Router Lite. Their review
baseline advances to 0a70b48c0ed7039034d097b4fd6a0e7e1e969143.

Switchyard stays pinned to fbabf51c62793ed0f6af042b60e92ce1cfba083b. Its observed
upstream head is 16cbe5939937f3106bc5f13d9b11cdfa64f3242a, twelve commits ahead
of the pin. The first ordered contribution patch conflicts in the runner's
algorithm imports; the second compatibility layer cannot be checked before
resolving that conflict. Upstream also changes its toolchain from Rust 1.96.1
to 1.99. Framework decision/capability refactors, optional failure cooldown,
cross-format schema enforcement, inactive advisor/escalation algorithms,
Anthropic translation, and Linux setup provide no required compatibility repair
for the current Windows TypeSafe/native Responses route. Keep the current pin;
a future update needs deliberate patch rebasing, build and runtime proof.

## Verification and boundary

- `npm run check`: direct pins, lock hashes, package boundary, applications and syntax passed.
- `npm test`: 360 passed, zero failures or skips.
- Production Node audit: zero findings.
- Hash-verified Python closure audit: zero findings.
- Windows Python 3.10 installation and dependency consistency: passed.
- Real local gateway qualification: passed for both retained GLM endpoints.
- Updated installed-Codex catalog parsing: passed for all 16 models.

The installed live virtual environment was not replaced. Deployment, installed
health acceptance, and renewed native collaboration certification are separate
from these source and local integration results.
