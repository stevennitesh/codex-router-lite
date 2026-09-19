# Switchyard affinity and patch cleanup

Historical delivery record: implementation accepted after final review, 2026-09-19.
Starting comparison: `9f7774dbb13fa00549af23bf5cb8fa680ec2f397`, clean checkout.
The user requested analysis and execution of the supplied review of the full
Switchyard implementation through deployed runtime `e37672c4`.

## Outcome and boundaries

Keep the chosen native model and reasoning variant through its tool trajectory,
and remove generic Switchyard changes that the current Router Auto route does
not need. Preserve the latest-user Jev selector, full native request, conservative
fallbacks, target aliases, catalog safety, and response identity guarantees.
This is a surgical correction, not a routing redesign or calibration project.

The patch visibly omits `shell_call_output` and `apply_patch_call_output` from
the affinity output list while the decoder/selector recognize these forms.
Shared task-message shaping and hidden-judge tier propagation also remain in
the patch despite Jev using a dedicated selector/client. Reproduce the affinity
failure and inspect current consumers before removal; reviewer assertions alone
are not proof that every proposed deletion is safe.

## Delivery approach

1. Reproduce native Responses continuation using explicit wire items, with an
   initial non-Sol selection. Repair affinity for shell and apply-patch outputs,
   preserving generic output forms and genuine-new-user reclassification.
   Cover both replayed history and output-only continuation where supported.
   Do not introduce a generic protocol registry merely to consolidate lists.
2. Trace current route dependencies for shared `task_messages()`, hidden
   `llm_judge` priority propagation, and removed scalar Responses encoding.
   Restore upstream behavior where no current-route requirement remains; remove
   corresponding obsolete tests/comments. Keep a codec deviation only with a
   concrete failing supported-path regression demonstrating its need. Preserve
   native answer priority propagation independently of hidden-judge policy.
3. Reconcile `empty_state` in existing maintained fallback documentation and
   trace expectations. Inspect actual installed target/public input modalities.
   Keep conservative catalog behavior if image input is already available; if
   a real supported media regression is found, bring the dispatch/capability
   decision back for review before widening the public contract.
4. Only if existing status plumbing can expose sanitized classifier-unavailable
   readiness directly, add that small diagnostic and its test. Otherwise record
   the optional polish as deferred; add no monitoring subsystem or state model.
5. Regenerate the canonical patch/source lock, prove ordered replay from the
   locked base, and update durable guides at their existing owners. Preserve
   prior exact-runtime evidence; changed source cannot claim existing v2 proof.

## Acceptance and final review

One final integrated gate, F1, covers the complete change against the starting
comparison. No intermediate checkpoint is needed for this bounded patch cleanup.

- Decoder/router integration tests use literal protocol names independently of
  implementation constants: initial Luna/Astra selection, native shell output,
  native apply-patch output, unchanged exact target/effort identity, and unchanged
  Jev call count. A subsequent genuine user turn still triggers classification.
- Full native tool items remain intact. Existing unknown/media/empty behavior and
  generic tool continuation tests pass.
- Each retained generic deviation has a current supported-path reason; each
  removal restores the locked upstream behavior with relevant regression checks.
- Fresh ordered patch replay, affected Rust tests, formatting and lint pass;
  repository checks, Node suite and current native catalog checks pass. Reuse
  valid evidence where code and dependencies are unchanged. No paid evaluation
  is required for unchanged routing criteria.
- Report installed modality observations, cleanup decisions, remaining justified
  patch surface, and limitations. No live deployment, certification, commit or
  push is part of this implementation request.

After acceptance, keep durable rules in maintained guides and archive this
completed delivery record under `docs/history`, repairing its pointer. A future
authorized deployment must rebuild and renew exact-runtime Switchyard proof.

## F1 candidate result

The source candidate keeps `shell_call_output` and `apply_patch_call_output`
inside user-turn affinity. Its decoded Responses regression selects the exact
`astra-medium` alias from two aliases over the same synthetic Astra upstream,
keeps fixed `medium` reasoning and answer priority through replayed shell history
and an output-only apply-patch continuation, makes no additional Jev call, and
reclassifies the next genuine user turn.

Shared `task_messages()` shaping and generic hidden-judge priority propagation
were restored to the reviewed contribution because the Jev route has its own
latest-user selector and provider client. Answer priority remains covered on the
actual answer path. Scalar Responses input normalization remains because the
recorded subscription-endpoint smoke rejected the scalar top-level form with HTTP 400;
the retained regression and
[`2026-09-18-switchyard-b1-evidence.json`](2026-09-18-switchyard-b1-evidence.json)
bind that supported-path reason.

Installed Switchyard, Luna, Sol, and Astra catalog entries all advertised text
and image input, so no modality change was made. Classifier readiness in the
current doctor plumbing would require new health state ownership, so that
optional diagnostic remains deferred. The canonical compatibility patch is
`adbffdb89c194c0d8f45eec13d38bf9feeea49bad86615cef60ee182e2ac3c66`.
The checked source remains v1/draft until a later exact-runtime deployment and
certification; historical installed-runtime evidence remains unchanged.

Final validation: 249 Node tests, affected Rust package suites, workspace lint,
formatting, fresh ordered patch replay and release build, repository checks, and
the installed native catalog check passed. Final review required one test-coverage
correction and found no remaining actionable findings. No commit, publication,
deployment, paid calls or certification was performed for this delivery.
