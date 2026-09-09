# Engineering contract

Use this guidance to make engineering decisions within the requested change.
Repository-specific requirements and accepted domain decisions supply the local
meaning. Apply a conditional practice only when its condition is present.

## Understand the behavior

Trace the request through the owning code, real callers, data flow, and existing
tests. Distinguish intended behavior from an implementation accident. Preserve
accepted contracts and unrelated work; resolve consequential ambiguity from
the user or the source that owns the decision.

Work in the smallest useful slice that completes the requested outcome. When a
named uncertainty warrants an early probe, build a thin real path to learn from,
then complete the outcome. The probe is evidence, not completion.

## Choose a design callers can use

Sketch real usage when changing an interface. Include the relevant errors,
ordering, and state transitions, not just the successful signature. Keep behavior
in its current owner unless moving it solves a demonstrated design problem.

Subtract or reuse before adding machinery. Prefer language, platform, and
repository capabilities. Add abstractions for meaningful policy or variation;
keep together decisions that must change together. Separate independent policies
when sharing an owner creates demonstrated coupling; small duplication is
preferable to coupling different domain meanings. If deleting a layer removes
complexity, collapse it. If complexity spreads to callers, the layer earns its place.
Keep a value's source, governing policy, and possible mutations easy to locate
without tracing unnecessary layers or hidden state.

Model valid states and domain distinctions in data. Use the type system and
existing schemas to prevent meaningful mistakes without adding precision no
caller needs. Keep one source for derived state. Avoid casts or assertions that
conceal a missing validity check. When an authoritative schema defines a boundary,
use existing tooling to derive or check its types rather than maintaining a parallel
definition. Preserve domain distinctions where the boundary representation differs.

Validate untrusted input where it enters a trusted representation. Rely on an
invariant only while its guarantees hold; mutation, persisted data, or concurrent
writes can invalidate it. Put any necessary recheck at the boundary that owns
that change rather than scattering defensive checks through ordinary code.

Keep calculations separate from effects where that makes behavior clearer and
easier to test. Hide framework and storage details when callers do not need
them; do not add adapters solely to make a small design look layered.

## Complete the change

Fix the cause across affected callers within scope. When a change repeatedly needs
special cases, duplicated policy, or escape hatches, reconsider the underlying
representation or ownership before adding another workaround. Revise the affected
design within scope when that resolves a demonstrated problem; isolated exceptions
do not justify a broad rewrite.

Preserve meaningful failure
behavior; a fallback must not turn an error or incomplete result into apparent
success. Make partial outcomes explicit when callers need to handle them.

Migrate owned callers and remove displaced code, configuration, and tests
together when compatibility permits. Use staged migration when real consumers
or deployment ordering require coexistence. Keep the reason and removal
condition for a temporary compatibility path clear. When data outlives deployment
or consumers upgrade independently, account for old and new readers and writers,
existing-data conversion, and rollback limitations.

Update documentation when behavior, operations, or a non-obvious decision
changes. Prefer an existing type, constraint, or check to repeated prose when
it can enforce a recurring rule within the task's scope.

## Match proof to the claim

Run required checks and the nearest useful check that can fail for the changed
behavior. Add or change tests when they protect a meaningful contract. Assert
observable behavior rather than implementation wording or private structure.

For a fix, distinguish the reported defect. When a plausible wrong rule also
passes the ordinary case, choose an input or state where the outcomes differ.
Derive expected results independently of the implementation under test.

For numerical and data transformations, preserve material units, identity, time
and availability semantics, missing-value meaning, and precision. Validate
consequential method assumptions with an independent reference, analytic case,
or invariant; internally consistent calculations can still answer the wrong question.

For a changed integration, prove that the ordinary caller reaches the new
behavior. Pass actual produced output through the affected handoff and check
the meaning it could lose. A reconstructed object or a passing isolated helper
does not prove that connection. Check failure or partial-success paths when
their behavior is part of the changed contract.

Preserve the mechanism relevant to the claim. A substitute may prove application
policy while leaving persistence, concurrency, transport, or rendering behavior
unproved.

Reuse evidence while the relevant code, inputs, dependencies, and environment
remain valid. Broaden verification for shared impact, repository policy, or an
unresolved risk. If execution is unavailable, report the strongest available
evidence and the unproved claim. Completion follows the requested outcome,
not merely a successful command or an exhausted budget.

## Handle effects where they occur

For retryable effects, establish identity and a recovery strategy so reruns do
not duplicate work. On partial or uncertain success, inspect actual state before
retrying. Give acquired resources an owner and cleanup behavior, including
failure or cancellation paths when applicable.

For concurrent mutation, eliminate unnecessary shared state first. When sharing
is required, enforce ownership or serialization through the actual mechanism;
separate files or worktrees do not isolate shared databases, ports, or services.

When work can accumulate or share scarce resources, define appropriate limits
and cancellation behavior so a slow dependency or caller cannot cause unbounded
growth or exhaust unrelated work.

For consequential performance or resource claims, compare equivalent work
against a baseline under relevant conditions. For external mutations, establish
the target and authority and read back the result. Review findings and delegated
results against the actual candidate and artifacts.

These conditions do not start additional workflows. Use TDD, delegation, formal
review, and operational procedures when the user or applicable instructions
call for them. Report the outcome, decisive evidence, and material limits.
