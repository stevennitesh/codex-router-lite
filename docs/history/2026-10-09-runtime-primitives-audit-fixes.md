# Runtime primitives audit fixes, 2026-10-09

The user selected analysis and repair of all findings in the `runtime-primitives`
subsystem of atlas run `20261007-structure`. Seven candidates were analyzed before
implementation. The separate retry/liveness policies and bounded resource owners
remain justified.

## Repairs and cleanup

- The synchronous skills lock publishes a fully initialized directory containing
  a unique owner filename. Recovery and release unlink only that filename and use
  nonrecursive `rmdir` for the shared path. A delayed recoverer cannot remove a
  replacement owner. Only `ESRCH` establishes PID absence; other probe errors
  preserve the lock. A real two-process schedule covers both old and new lock
  formats, and a delayed-release control preserves a replacement generation.
- Old dead/partial/empty lock artifacts remain recoverable. The skills ownership
  journal format is unchanged, and live old owners remain excluded. End older
  skill-maintenance processes before switching implementations: an already
  running old recoverer still uses the retired recursive-deletion protocol.
- Proxy diagnostics redact complete authority userinfo, including passwords with
  multiple raw or encoded at signs. Path/query at signs and ordinary host/bypass
  forms retain their display. All regression credentials are synthetic.
- Service proxy handoff and transport selection share independent HTTP/HTTPS
  address precedence. Empty HTTP no longer masks configured HTTPS when retaining
  saved permission. Explicit opt-out and positive Node CLI/options opt-in remain.
- Request and buffered-response settings decode once as positive safe integer
  byte counts. Invalid settings fail startup with the setting name. Defaults,
  empty-as-unset and primary-before-Codex-alias precedence remain; HTTP and
  WebSocket consumers share only validated constants.
- Windows PowerShell explicitly produces UTF-8 for process probes. The actual
  service reader accepts the synthetic Unicode checkout anchor. No Codex binary,
  signed sandbox helper or persistent Codex setting was changed.
- Service recording and ownership checks use one fresh process snapshot. The
  PowerShell query checks generation before and after CIM/WMI command-line
  access. A changed generation or failed identity probe is unknown; missing
  command-line access cannot grant ownership. A positively verified different
  identity still proves that a recorded generation exited. Ordinary five-second
  and timeout-only cold-start budgets retain their values.
- The uncalled `windows-process-tree.ps1` helper and its package/parse inventory
  entries were removed. Current service and native-certification termination
  owners remain. Current code, dynamic-invocation and maintained documentation
  searches found no supported entry point for the retired helper.

## Verification and measured benefit

The first full shared-code run covered 684 tests: 682 passed and two service-stop
fixtures still emitted the retired text-only process-probe format. Those fixtures
were migrated to snapshot JSON, and all 25 affected service lifecycle tests then
passed. Product source did not change between the full run and that rerun. This
reuses unaffected passing tests rather than repeating the full suite. Source,
package and current installed-Codex catalog checks complete the verification.

The implemented `buildServiceProcessState` caller was compared with the retained
two-query baseline against the benchmark's own process, using a synthetic Unicode
entrypoint argument and matching UTF-8 output on both variants. Three alternating
warmed pairs returned identical identity, command line and checkout anchors:

| Local observation | Separate baseline | Implemented snapshot |
| --- | ---: | ---: |
| PowerShell launches | 2 | 1 |
| Median duration | 589.0 ms | 465.1 ms |
| Observed range | 586.0–589.4 ms | 443.0–487.6 ms |

This is about 124 ms, or 21%, less local ownership-probe time. Background load was
uncontrolled; these measurements do not establish model-call latency or an app-wide
performance guarantee. The status caller also performs one launch per observation.

Detailed audit, analysis, fixture, timing and verification artifacts remain local
under `.tmp/audit-codebase/20261007-structure/`. No provider requests, route
certification, live deployment, commit or push occurred in this repair task.
