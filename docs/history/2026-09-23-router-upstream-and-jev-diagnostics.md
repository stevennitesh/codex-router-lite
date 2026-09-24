# Router upstream review and Jev evaluator diagnostics - 2026-09-23

Historical compatibility evidence; current authority remains
`maintenance/upstream-router.json`, the maintained Switchyard evaluator, and
the current source.

## Original Router upstream

Advanced the reviewed original-Router baseline from
`5e1b49e6e3fea1ada57f0e7fa6ca7612e9d17300` to
`1a339dda8e6934024d933f9a48f4b9a7d954f6d0`.

The range contains 158 upstream commits. The source audit first dispositioned
the 143-commit range through `02b7ef98823165047fdab9ac2953730725450231`,
then reviewed the 15-commit tail through the new head. No upstream merge was
performed.

Retained-owner fixes already integrated into Router Lite include:

- stale native reasoning-effort repair after a model switch;
- patient LiteLLM cold-start recovery across bounded health budgets; and
- request-size-aware pre-content completion timing.

Other retained behavior was already covered by Router Lite's request-local tool
identity mapping and, after the dependency refresh, by pinned LiteLLM 1.102.1's
reasoning and terminal-usage behavior.

The new tail contains one retained-owner candidate that remains deliberately
deferred: upstream now bounds the process-wide TCP connect phase and derives the
pre-retry budget from the same bound. Router Lite still has a 5-second retry
budget while undici may take longer to report a connect timeout, so the upstream
change addresses a plausible reliability gap. It also changes process-wide
address racing and retry timing, so it was recorded for isolated
blackhole/proxy verification instead of being adopted as bookkeeping work.

The tail's non-streaming Chat JSON reasoning replay is already covered for the
retained GLM bridge by LiteLLM 1.102.1; Pareto remains direct Responses.
Control-center curation, changelog tooling, OpenCode-free client gating, and
documentation-only changes remain outside Router Lite's retained product
boundary.

## Jev routing diagnostics

The maintained Switchyard routing evaluator now emits descriptive routing
quality diagnostics without changing the route policy or its configured
threshold.

For development data it reports:

- raw and post-policy confusion matrices;
- confidence buckets with exact-label and acceptable-target rates;
- an ECE-style exact-label reliability diagnostic;
- multiclass Brier score against the authored expected label;
- mean top-two probability margin;
- fallback count/rate;
- severe under-routing and aggregate under-route distance;
- expensive over-routing and aggregate over-route distance; and
- a descriptive threshold sweep from 0.0 through 1.0 plus the configured
  threshold.

The threshold sweep is development-only. Holdout evidence is evaluated only at
the already-frozen configured threshold, so the new report does not create a
new holdout-tuning path.

Jev confidence is explicitly labeled as uncalibrated. The ECE and Brier values
are diagnostics, not claims that a confidence such as 0.8 means an 80% chance
of correctness.

Candidate-order stability is also explicitly marked unavailable. The current
Switchyard decision evidence exports only the probability distribution averaged
across its deterministic candidate orders; it does not expose the individual
per-order verdicts. The evaluator does not invent stability from the averaged
distribution.

No provider calls were made to create this source change. Fresh paid routing
evidence is generated only when the maintained evaluator is run against a
candidate with an authorized OpenRouter credential.
