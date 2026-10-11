# Diagnostics and update audit repairs, 2026-10-09

Historical local verification record, not installation instructions or live
runtime authority. The candidate was developed from `65386d15`; deployment was
not part of this work. Current procedures remain in the maintained installation,
troubleshooting and compatibility guides.

## Reproduced failures and repairs

- A successful checkout rollback leaves the old revision detached while `main`
  still names the newer revision. Update previously switched to `main` before
  requesting a drain. A refused drain therefore left newer source in place even
  though the error claimed the checkout was unchanged. Checkout discard, branch
  switch and merge now occur after preparation, with captured-revision recovery
  covering both transition and installer failures. Update and rollback preserve
  tracked edits on deferral, including with `--force`; preparation-time checkout
  changes refuse replacement.
- Compatibility refresh previously printed the same passing summary when the
  retained suite ran and when `-SkipTests` skipped it. Results now distinguish
  performed checks, skipped checks and unavailable observations. An unchanged
  complete refresh can still be reused deliberately without redundant tests.
- Doctor previously marked HTTP 200 as confirmed Router health even with an
  unrelated service or invalid JSON. Binary presence also marked an unavailable
  version as okay. It now preserves full-health identity, unknown version and
  safe degradation detail while retaining diagnostic warnings and independent
  deployment acceptance.
- Readiness previously reused an old module error after its missing entry had
  been repaired, then inferred a task-token failure from current path presence.
  The service caller now captures a log cursor before launch; readiness reads
  only subsequent bounded output. Diagnosis reports path presence/type and
  qualified resolution/access checks instead of asserting an unproved ACL cause.

## Local verification

`npm run check` and 94 affected tests passed. The tests use real disposable local
Git repositories, the exact compatibility PowerShell script, actual stable health
projection and executable-identity helpers, Node loader errors and ordinary
service-call handoffs. External native/provider/service boundaries are controlled.

Controls cover rollback followed by refused update, dirty edits and explicit
force, edits during preparation, failed merge/install recovery, local unpublished
and divergent commits, full/skipped/failed compatibility checks, malformed or
foreign health, unknown versions, stale logs with unrelated new output, fresh
module errors, log rotation/truncation and bounded reads. Existing Windows
installation and packaged deployment recovery/acceptance tests also passed.

This evidence establishes source and fixture behavior. It does not establish a
live replacement, native route certification, task-token ACL diagnosis or a
measured speedup. No live service, Codex configuration, helper binary, credentials
or provider quota was changed by these checks.
