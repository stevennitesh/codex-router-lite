# Catalog and config audit fixes, 2026-10-08

Historical source verification, not deployment or current runtime evidence.

The `catalog-config` audit in atlas run `20261007-structure` identified eight
defects and one cache opportunity, grouped into six candidates. All six were
analyzed before implementation. The baseline was Router commit
`69c0727d3b7857fbb83113105e373c4240c9b4db`; the results below describe the
working-tree fixes verified on this date.

## Completed changes

| Candidate | Implemented behavior |
| --- | --- |
| `catalog-config-toml-preservation` | Managed edits use decoded root key identities and real comment positions from the existing TOML scanner. Quoted foreign keys and duplicate keys are refused; marker examples inside multiline strings remain user content. Unmarked reserved provider tables are refused. |
| `catalog-config-local-state-errors` | Effective provider, picker and subagent readers distinguish missing state from malformed or unreadable state. Publication validates these selections before seeding or refreshing account state. Diagnostic commands report a bounded error without inventing effective choices. Supported legacy picker reconstruction and ignored retired providers remain usable. |
| `catalog-config-agent-removal` | Required deletion and enumeration failures enter existing publication recovery. Earlier deletions are restored; incomplete agent restoration cannot produce the safe-rollback exit code. User-owned agent filenames remain outside synchronization. |
| `catalog-config-picker-serialization` | Operator provider, picker and subagent writes acquire the existing catalog publication lock before reading their mutable snapshot. Publisher seeding remains inside that lock. Actual CLI and provider-key callers await completion. |
| `catalog-config-disable-ownership` | Disable preserves an unmarked foreign catalog when no source was adopted, preserves a matching user assignment verbatim, and restores only a known adopted source. Invalid or inaccessible adoption state prevents mutation. |
| `catalog-config-cache-revalidation` | Successful matching 304 and unchanged 200 validation persists an optional `validated_at` timestamp in the existing private cache. Freshness uses it with a `fetched_at` fallback; model content and fingerprints remain unchanged. |

Schema and absence policy remain at the separate settings owners. Only mechanical
file/read/JSON outcomes are shared through `readJsonFile`. Read-only settings and
inference paths do not acquire the publication lock. Existing account identity,
residency, client-version, forced-refresh and private-file protections remain.

## Verification

`npm run verify:codex` passed all 668 tests with no failures or skips, Python lock
validation, syntax checks, the product/package boundary and nine accepted
v2-agent applications. Installed Codex CLI `0.162.0-alpha.2` parsed 17
current-schema models and passed the routed catalog compatibility checks.
The Windows test process used the normal user identity to read its own fixtures
after Router applied owner-only ACLs.

The new ordinary CLI regression tests exercise invalid JSON, wrong schema,
injected read/probe denial, required deletion denial, enumeration denial,
incomplete restoration, and two real processes overlapping at the picker
replacement boundary. Their assertions check unchanged bytes, retained roles,
honest failure, lock release and successful retry. They also check two disjoint
operator visibility changes survive.

An independent Python 3.12 `tomllib` check parsed before/after output from the
ordinary config CLI. Both basic and literal multiline instruction values survived
enable, repeated enable and disable, with and without an adopted source. Decoded
user values matched their original values; repeated enable was byte-identical.
Valid quoted foreign keys and a reserved provider table were refused without
changing bytes; no-source disable preserved the foreign catalog assignment.

## Cache cost comparison

The comparison used the baseline cache owner from the commit above and the
candidate owner, Node `v24.13.0` on Windows, an 88,270-byte synthetic catalog,
real loopback HTTP and real protected atomic writes. Three rounds alternated
baseline/candidate order. Clock spacing was simulated; HTTP delay was imposed
only in the explicitly labeled case. Timings are median total milliseconds for
the entire equivalent call sequence, not production inference latency.

| Calls and simulated spacing | HTTP delay | GETs before → after | Private writes before → after | Total ms before → after |
| --- | --- | --- | --- | --- |
| 30 calls, 10 seconds | 0 ms | 30 → 1 | 0 → 1 | 412.97 → 257.56 |
| 30 calls, 10 seconds | 100 ms | 30 → 1 | 0 → 1 | 3,226.62 → 357.42 |
| 3 calls, 1 second | 0 ms | 3 → 1 | 0 → 1 | 38.06 → 235.98 |
| 2 calls, 5 minutes | 100 ms | 2 → 2 | 0 → 2 | 216.60 → 666.74 |

Persisted validation removes repeated requests within the TTL across processes.
With few fast requests, private Windows writes cost more than the saved HTTP.
At the default five-minute watcher cadence this comparison adds about 225 ms per
unchanged refresh in its separate process. It establishes no app or inference
speedup at that cadence. The change retains private atomic writes rather than
using filesystem modification time as validation authority or adding another
state store. Forced refreshes still request account validation.

No live user config, service replacement, provider inference, Desktop picker
adoption or native route renewal was exercised. The tests and comparison used
synthetic state; existing route proof records were unchanged.
