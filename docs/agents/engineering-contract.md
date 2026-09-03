# Engineering Contract

<!-- programming-agent-skills setup-file: engineering-contract.md:d0213d0d3b47 -->

Explore imaginatively. Converge under proof. Simplify ruthlessly.

This contract teaches shared engineering judgment. It is not a workflow,
checklist, review gate, completion format, or authority to mutate anything.
Follow the user, repository instructions, accepted domain decisions, and
current source. Skills own procedures and stopping conditions.

## Understand before changing

Trace the request through the code that owns the behavior, its real callers,
data flow, and existing proof. Preserve accepted behavior, domain meaning,
contracts, and unrelated work. Surface a consequential ambiguity instead of
inventing product intent.

Work in a **bounded slice**, the smallest useful change that preserves the
requested outcome and can produce meaningful evidence.

Use a **tracer bullet** only when a named risk warrants early feedback. Build
the thinnest real path that produces an observable signal, learn from it, then
complete the bounded outcome. It is a learning role, not a substitute for
acceptance or a requirement to touch every layer.

## Design for simplicity

Choose the smallest integrated design that makes the behavior clear. Subtract,
reuse, or replace before adding another path. Keep behavior in its current
owner unless moving it solves a demonstrated ownership problem.

Model the domain with clear data shapes, explicit relationships, and
representations that make invalid states difficult to express. Prefer small
interfaces, local state, readable control flow, and modules that hide their
internal complexity.

Apply the deletion test. If removing an abstraction makes complexity
disappear, collapse it. If meaningful behavior or policy spreads back across
callers, the abstraction earns ownership.

Apply YAGNI: add machinery only for a current requirement, supported variation,
or demonstrated value. Start with the language, framework, repository
conventions, existing abstractions, and installed dependencies. Do not unify
code merely because it looks similar. Prefer small local duplication when a
shared abstraction would couple different meanings or owners.

Fix the cause across affected callers instead of guarding one symptom. Trust
internal types and established invariants. Validate untrusted,
machine-consumed input once at the boundary that owns it, then pass a valid
internal representation onward.

Keep framework, transport, and storage representations at the edge. Pass
domain values into core logic and prefer explicit results over hidden mutation.
Derive secondary state from one source of truth instead of synchronizing
copies.

When an authoritative schema defines a boundary shape, derive its boundary type
with existing repository tooling instead of maintaining a parallel copy. Keep
that type at the edge and pass only the domain values or model the core needs.

## Implement the whole change

Preserve the behavior and failure semantics the accepted contract exposes.

Remove code, callers, flags, configuration, tests, and documentation displaced
by the change. Keep an older path only for a named compatibility, migration,
recovery, or ownership need.

Update documentation when the public contract, operator procedure, skill
usage, or a durable non-obvious decision changes. Readable code needs no
restating comment.

## Prove the claim

Run the nearest useful check that can fail for the changed behavior. Prefer the
real caller or artifact over an isolated implementation detail. Add or change
a test when repository policy requires it or when it is the cheapest durable
protection for meaningful behavior.

Before keeping a test, name the realistic behavior break it catches. Assert
observable results or effects instead of source text or private structure.

Broaden proof only for shared impact, repository policy, or a concrete risk.
When the implementation could confirm its own mistake, use an independent
oracle. If safe execution is unavailable, use the strongest safe proxy and
state what remains unproved.

## Activate protection from evidence

Add the smallest protection required by the request, repository, or accepted
behavior, including correctness at an active trust or effect boundary. Ask only
when evidence leaves an unresolved choice that would create or change a
consequential product or operating commitment. Otherwise omit it. Local or
personal use alone is not a trigger.

Destructive work needs an exact target and approval. External durable mutation
needs authority and read-back.
Concurrent writers need isolated ownership and one integrator. Formal review
needs a fixed candidate. Operations that can partially succeed need a recovery
path. An operation expected to retry, resume, or restart should converge on
rerun without duplicate effects. Consequential performance, capacity,
reliability, latency, cost, or resource claims need comparable measurement.

An inactive condition creates no checklist, artifact, reviewer, status field,
or explanation obligation. Use TDD only when the user explicitly requests
test-first work or repository policy requires it. Delegate only when the user
explicitly requests subagents or an invoked skill owns required fanout. Use
independent review, security work, deployment, or production operations only
when the user, repository, or accepted task activates them.
