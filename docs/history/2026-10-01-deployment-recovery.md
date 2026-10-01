# Checkout deployment recovery, 2026-10-01

The rate-limit fix at `3ecb4a58` was pushed, but deployment did not activate it
reliably. A drain timeout entered rollback because activation was marked before
the guarded stop. Recovery then attempted a stop through the candidate checkout,
which could silently leave an orphan from the previous checkout alive. After a
manual installation, the manifest and launcher named the candidate while the
previous rollback process still served healthy HTTP requests. Its catalog refresh
failed the state ownership check. HTTP health alone therefore overstated success.

The repair gates activation on accepted admission drain, stops the verified live
checkout, checks process and listener shutdown before replacing runtime files,
and retains the snapshot if recovery cannot finish. Installation refuses ownership
transfer from a live different checkout. The Windows manager stops before writing
launchers and reports remaining processes or listeners as failures.

The checkout deployment launches a hidden WMI worker independent of the calling
tool's process tree. It serializes deployments and records private completion and
log files. A retained-snapshot recovery option handles the verified mismatch above
without relaxing final task/process/manifest/provenance acceptance.

Failure-injection coverage executes the shipped activation and file restoration
code, with Windows service/authentication boundaries replaced by fixtures. It
covers drain refusal, install and health failure, failed shutdown, failed recovery,
and exact restoration. The independent-worker fixture terminates the entire caller
tree before failing candidate activation and completing rollback. This establishes
local transaction policy and caller-disconnect survival, not provider routing or
renewed runtime certification. Live deployment acceptance remains separate.
