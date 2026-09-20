# Native relay selection and compatibility maintenance

Technical delivery plan, 2026-09-20. Implementation reviewed; release pending.
Baseline: `691cf9a404be2a0c48b05ea6c1412d6b9214b9f6`, Router 0.7.0.
The accepted deployment is not considered broken by this review.

## Outcome

Keep encrypted-task extraction reproducible: a missing tested relay model must
not silently select another catalog model. Make the observed ciphertext format
an explicit compatibility assumption, and repair the identified documentation
drift without redesigning working routing or certification.

Baseline inspection confirmed `nativeAgentRelayModel()` selected an
arbitrary listed/available model when Sol is missing, and returns the Sol slug
when the catalog was empty, unreadable or malformed. The baseline source comment
also described all OpenAI ciphertext as Fernet rather than an observed format.

## Intended changes

### Deterministic relay selection

- Preserve the existing explicit `MODEL_ROUTER_AGENT_RELAY_MODEL` override. It is
  an intentional operator choice, not automatic substitution or evidence that
  another model has passed extraction-fidelity tests. A failed explicit choice
  must not silently try a different model.
- Without an override, use `gpt-5.6-sol` only when the native catalog contains it.
  Missing Sol, an absent/unreadable/malformed catalog or an invalid model list
  produces a controlled relay-unavailable failure before a native relay call.
- Use the existing caller-specific failure paths: Switchyard converts extraction
  failure to its null projection and zero-Jev Sol answer fallback; external
  routed-agent normalization retains its explicit error behavior. Do not send
  opaque ciphertext onward as supposed plaintext or invent a task answer.
- Sol answer fallback is not a promise that the account can execute Sol when the
  catalog lacks it. Existing native answer errors remain visible to the caller.
- Do not change account partitioning, caches, coalescing, cancellation, timeout,
  extraction prompts, plaintext handling, model policy or tool affinity.

Implementation remains in the existing relay owner. Reuse its controlled error
type/status conventions; no new registry, fallback ladder or public settings.

### Version-bound ciphertext observation

Keep the existing discriminator unchanged. Replace its universal guarantee with
the fact that `gAAAAA...` is the observed native agent-payload representation for
the currently tested build, while `encrypted_content` is protocol-opaque.

Extend the existing Codex update checklist with a fresh synthetic encrypted
child handoff. Verify the actual representation is recognized and its plaintext
is recovered faithfully; verify a readable routed-child control remains readable.
Record the tested app/CLI identity in normal sanitized compatibility evidence,
without retaining ciphertext or private text. If a new representation appears,
do not claim compatibility from catalog tests alone: investigate and withhold
acceptance for the affected path. Do not add a generic ciphertext detector now.

### Focused documentation repairs

- Remove the nonexistent domain-guide reference from context ownership.
- Put the 0.7.0 thread-admission completed record and release evidence first in
  the Switchyard history index, retaining their historical status.
- Expand `non_text_state` to include attempted projection without safe text.
- Qualify SECURITY's latest-user-turn statement as ordinary-turn behavior.
- Describe intact task/conversation content in README, while acknowledging
  routing-owned request-field changes; do not promise byte-identical requests.
- Reconcile the accepted-route statement in certification docs with checked-in
  route/proof authority, including Switchyard where accepted. During candidate
  invalidation, do not leave documentation falsely claiming current acceptance.

No sensitive-path freshness checker, proof-schema expansion, desktop identity
schema field, comp_hash bump, upstream repin or patch-size refactor is included.

## Delivery and proof

1. Trace relay selection through Switchyard and external normalization callers.
   Add focused regressions for explicit override, Sol present, Sol absent with
   other models available, missing/malformed catalog and failed override.
   Test whitespace-only override as unset. Establish zero native extraction
   calls when selection is unavailable, no arbitrary fallback, Switchyard null
   projection, and explicit external-route failure. Reuse existing real Rust
   null-projection/no-Jev proof rather than reimplementing the classifier in a mock.
2. Make the narrow selection change and documentation repairs. Preserve the
   compatibility discriminator and all unrelated behavior. Mark certification
   applications affected by shared relay behavior provisional according to the
   existing guide; inspect actual callers, do not assume only Switchyard is affected.
3. Run focused tests, `npm run verify` and applicable catalog/application checks.
   Review the complete candidate against this baseline. No Rust rebuild is needed
   if the locked Switchyard source/patch remains unchanged.
4. With release authority, commit and deploy using the existing rollback-owning
   transaction. Run fresh synthetic extraction on the deployed default Sol path,
   native same-child continuation/tool tests and required exact-route renewals for
   affected routes. Use isolated catalog fixtures for unavailable-model cases;
   do not remove production catalog entries to test failures. Bind proofs to the
   deployed candidate, retain rollback on failure, and promote only accepted paths.
5. Archive a sanitized technical outcome once delivery completes. Keep worker
   orchestration and machine-local paths outside tracked documentation.

Acceptance requires deterministic selection, controlled failure at both callers,
unchanged successful extraction/continuation behavior, truthful compatibility
guidance, passing required checks and deployment-bound proof where applicable.
Unit tests establish branch behavior, not arbitrary-model extraction fidelity.

Status: implementation and review complete. All 256 verification tests and
applicable catalog/application checks passed. The four affected source
applications are v1/draft pending deployment and fresh certification; the
installed runtime is unchanged. Commit and push are authorized. Deployment
and live certification remain pending separate release authorization. This plan
does not authorize a new public tag/release or changes to user configuration.
