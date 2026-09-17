# Router stress-test delivery

Status: historical completed delivery record, revision 2, 2026-09-17.
Current execution instructions live in [Debugging](agents/debugging.md#bounded-stress-checks).

Delivered a shared isolated fixture and seven bounded stress tests spanning the
native, GLM, direct Responses and Switchyard boundaries. The suite reproduced a
forwarder defect: provider disconnects after partial output ended without a
terminal error. The fix uses the existing stream-error owner; reverting it fails
the regression. No test platform, dependencies or live-provider automation were
added. Union's retirement interrupted initial implementation; its fixture contract
remains testable without calling the retired endpoint.

F1 passed after correcting timeout polling and strengthening actual forwarded
history assertions and the concurrency arrival barrier. The final stress run
passed 7/7; the full suite passed 206/206. Repository checks, installed-CLI catalog
compatibility and whitespace checks passed. Live soak, native encrypted-reasoning
proof, deployment and Pareto migration were not performed or certified by this
delivery. The original comparison was commit
`1b9f9deb684cb6a46f9e6461f7d0e947f6bd9ada`; changes remain uncommitted at acceptance.

## Purpose and accepted scope

Catch protocol and lifecycle regressions that happy-path endpoint checks miss,
without building a testing platform. Extend the existing Node test suite and
isolated Router/provider fixtures for this personal Windows workflow. Preserve
all endpoint contracts, native behavior, privacy boundaries and the existing
[engineering contract](agents/engineering-contract.md).

Required outcomes:

Coverage applies to the overall Router: native pass-through, both configured GLM
endpoint policies, direct Responses adapters, and the Switchyard local-hop path.
Use representative cases at each distinct boundary and shared fault cases where
they exercise shared owners; avoid duplicating every scenario for every slug.
An offline Union adapter case remains useful even if the live preview is retired.
Do not migrate or remove that live route as part of this testing delivery.

1. Deterministic provider fault cases exercise the real Router path: fragmented
   streams, empty function arguments, inconsistent argument lifecycle events,
   explicit errors after partial output, premature disconnects and HTTP 429/504.
   Assert diagnostic preservation, identity/history integrity, bounded attempts,
   and no invented arguments or apparent successful completion after failure.
   Preserve intentional existing retry policy; do not redefine it to fit a test.
2. Repeated tool/history/compaction sequences preserve current requirements and
   evidence while allowing resolved blockers and stale hypotheses to disappear.
   Feed actual produced checkpoints/history into subsequent stages. Cover routed
   model switching using local fixtures; mark native encrypted-reasoning and live
   provider behavior as distinct integration proof, not simulated certification.
3. A small bounded concurrent run checks request isolation, cancellation before
   headers and during a stream, and a stalled request alongside a healthy one.
   Own and clean up child processes, sockets and temporary files on failure too.
4. Failures identify scenario and seed where random chunking/order is used.
   Keep prompts, credentials, argument contents and private histories out of
   runtime diagnostics. Add production instrumentation only for a demonstrated
   attribution gap, not a general observability subsystem.
5. One documented command runs the bounded offline coverage. Document a short
   manual live-soak procedure with explicit request/time limits, synthetic data,
   acceptance and cleanup. Offline tests consume no provider quota and never
   modify the installed runtime. Live tests must be explicitly invoked.

Exclude dashboards, schedulers, distributed runners, benchmark infrastructure,
new dependencies unless unavoidable, a general scenario DSL, certification renewal,
automatic deployment, and speculative production fixes. Reuse existing fixture
helpers where useful; extract a shared helper only for actual duplication. Any
new reproducible Router defect should receive a narrow root fix and regression;
raise consequential contract changes before implementation.

## Delivery approach and acceptance

- Inventory current coverage and add only missing cases. Prefer extending nearby
  tests over an independent framework. Routine fixture/file organization is up
  to the implementer.
- Deliver faults, produced-history transitions, and concurrency/cancellation as
  one coherent candidate. A final-only gate is sufficient because there is no new
  public interface or persistent format to approve in stages.
- **F1 — integrated review:** review the whole change against this scope. Evidence
  must include the bounded stress command, `npm run check`, `npm test`, and current
  installed-CLI catalog compatibility per [verification](agents/architecture.md#verification).
  Demonstrate a relevant known-bad fault is detected, retain successful controls,
  and distinguish injected provider failures from Router defects. Verify cleanup
  and repeatability without relying solely on wall-clock timing assertions.
- Finish with concise delivered coverage, bugs found/fixed, evidence and limits.
  Keep maintained execution instructions in the debugging/verification owner;
  mark this record historical when completed and avoid adding it to always-loaded
  agent context. Commit, push and deployment are outside this delivery request.
