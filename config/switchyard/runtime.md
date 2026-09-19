# Switchyard runtime operations

Read for startup, health, provider selection, or current-generation diagnostics.
First read the [integration boundaries](README.md). For live replacement, use
[maintenance](maintenance.md#deploy-and-roll-back); diagnosis does not start a deployment.

## Runtime supervision and diagnosis

Router starts Switchyard only when the `switchyard` provider is selected. It
validates the installed binary and route file, rejects non-loopback overrides,
waits for `/health`, watches the child, and owns its lifetime. Do not start a
second process. A Switchyard exit ends the Router generation so the OS
supervisor can rebuild one coherent stack.

Defaults and supported overrides:

- root: `%CODEX_HOME%\switchyard` or `CODEX_ROUTER_SWITCHYARD_ROOT`;
- binary: `switchyard-server.exe` or `CODEX_ROUTER_SWITCHYARD_BIN`;
- config: `routes.toml` or `CODEX_ROUTER_SWITCHYARD_CONFIG`;
- address: `http://127.0.0.1:4000/v1` or
  `CODEX_ROUTER_SWITCHYARD_BASE_URL`.

Diagnose the first failing owner instead of restarting blindly:

| Observation | Meaning and action |
| --- | --- |
| Provider enable is blocked | Binary or route file is incomplete. Compare runtime status with the lock and staged artifacts. |
| Selected provider starts with a warning but no child | The previously selected runtime is now incomplete. Repair/deploy it before re-enabling; do not create a placeholder. |
| Non-loopback override is refused | Expected fail-closed behavior. Restore loopback; do not widen the listener. |
| 401 from `/v1/models`, `/v1/decision`, or serving endpoints | Expected without the ephemeral hop capability. Test through Router unless specifically proving the negative boundary. |
| `local-hop capability is unavailable` | Router and Switchyard were not started as one supervised generation. Find the lifecycle/config split; do not paste a static capability into files. |
| Router health reports `degraded: ["switchyard"]` | The selected child is unreachable. Inspect the supervised child exit and active config before any restart. |
| Switchyard exits and the whole Router service exits | Expected generation ownership. Fix the child root cause; the service supervisor restarts the coherent stack. |
| Task Scheduler reports `0x800710E0` while Router is healthy | The minute heartbeat tried to start the running task and `MultipleInstances=IgnoreNew` rejected the duplicate. Use Router health, managed task state, and process identity as authority. |

Summarize only the latest supervised generation without copying request bodies,
headers, capabilities, or raw agent identifiers:

```powershell
.\model-router.ps1 codex switchyard-trace
```

The summary reports status counts, selected targets, classifier failures, and
agent/correlation cardinality. The TypeSafe routing policy also reports
bounded counts and recent provider builds, final targets, HTTP status where useful,
confidence, threshold, decision latency, and sanitized fallback reasons. It
never includes decision state, provider bodies or credentials. `/health` reports
immutable startup readiness (`ready`, `unavailable` with a local reason, or
`unknown` for programmatic construction). Per-request failures remain in traces
and do not mutate readiness. Use the raw log only when this redacted summary
cannot distinguish the failing owner.

For a bounded certification packet that combines Router timings with the
current generation's routing decisions, without emitting session, agent, or
correlation identifiers, run:

```powershell
.\model-router.ps1 codex switchyard-certification-evidence --limit 20
```

Treat only successful entries from one clean window as proof. Cancellations and
older generations remain diagnostics, not certification evidence.

Provider selection changes the supervised child set and therefore requires one
guarded Router restart:

```powershell
$routerRoot = (& git rev-parse --show-toplevel).Trim()
& (Join-Path $routerRoot "model-router.ps1") codex providers enable switchyard
& (Join-Path $routerRoot "restart-codex-router.ps1") -InstallDir $routerRoot
```

Never issue a standalone stop during maintenance.
