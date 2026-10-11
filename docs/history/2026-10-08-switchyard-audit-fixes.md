# Switchyard audit repairs and Sol High policy

Source work on 2026-10-08 resolved the three Switchyard candidates in atlas run
`20261007-structure`. This record describes source acceptance and a candidate
build, not an installed release or renewed native proof.

## Repairs

| Finding | Cause | Repair and distinguishing check |
| --- | --- | --- |
| Supplemental smoke attribution | A fixed session and global time-window records could supply another conversation's matching targets. Media and compaction used global counters. | Each phase now has a UUID session/thread identity and start/end window. The two tool requests share one identity. The existing evidence owner selects agreeing identities and requires its own successful public Router completions. The ordinary CLI passes with interleaved foreign traffic and refuses own drift, absent own records, absent media evidence and own compaction classifier activity. Contradictory identities and sub-millisecond boundaries have separate controls. |
| Evaluator fallback parity | The validator admitted any registered local fallback, policy trusted that reported target, and runtime parity skipped local vectors. | Expected `non_text_state` and `state_too_large` evidence must use canonical `sol_high`. Policy derives that target independently and parity checks local vectors. `requestVector` rejects every wrong configured target without spending its transient retry. Provider probability and build diagnostics still exclude local zero-call vectors. |
| Numeric configuration values | Regexes read numeric prefixes rather than complete effective TOML values. | The existing structural scanner selects unique active assignments. A bounded decoder consumes complete decimal values, separators and threshold exponents, and rejects unsupported or malformed syntax. Expanded timeout, byte limit and context mutations now fail the contract. Python `tomllib` independently agrees on all nine supported-value and inactive-text controls. |

The repairs reuse the trace/identity and TOML structure owners. They add no
provider dependency or per-inference configuration parsing. Native child
correlation, classifier egress limits and historical usage meanings remain
covered by their existing controls.

## Requested target change

The user selected GPT-6.1 Sol High as the replacement for Switchyard's previous
Sol Medium slot. The template now registers `sol_high` / `switchyard/sol-high`
with `gpt-6.1-sol` and `high` effort. It is the uncertainty and local fallback.
Native V1/V2 compaction uses the same model and effort while preserving reasoning
siblings. The catalog behavior template, compatibility family, default effort,
worker definition, evaluator labels and authored corpus match that policy.
Luna Max and the two Astra targets retain their settings.

The compatibility patch emits the new Sol High probability field and updates its
target fixture. `source.lock` binds the changed patch. Historical trace readers
accept either complete four-label schema; they do not accept a mixed five-label
probability map. Old Sol Medium records remain interpretable.

The installed Codex 0.162.0-alpha.2 bundled catalog supports `gpt-6.1-sol` with
`high` effort. Its catalog parser accepted all 17 merged current-schema models.
This is an offline compatibility check, not a fresh account entitlement or
provider inference measurement.

## Acceptance and remaining release work

- `npm run verify:codex`: 673 tests passed, zero skips, plus syntax, boundary,
  dependency-lock and active application checks and installed catalog parsing.
- Exact locked Switchyard source: Rust 1.96.1 formatting and workspace clippy
  passed; 866 unit, integration and documentation tests passed, zero ignored.
- The maintained recording-provider fidelity runner passed all eight cases:
  six exact-state checks and two zero-call fallbacks.
- The release binary built successfully and accepted the actual new template
  with a closed loopback answer URL in `--dry-run` mode.
- Binary SHA-256:
  `c8f0434a224a84a7db769f1eb0ca392e6f4159fc5e4e87fa330cfff7dca5dca1`.
- Compatibility patch SHA-256:
  `bf4df8b4430032cc67ef138bbbc83aea725e509e41d992ba3a5b1be52a8cc497`.

The previous [proof](2026-10-08-switchyard-sol-medium-proof/proof.md) and its
JSON were moved unchanged to history. The archived template preserves the
configuration bound by the earlier C2 quality record. They do not certify the
new binary, target or Router source. Switchyard's candidate declares subagents
v1 until a new runtime-bound application is accepted; validator tests use
explicitly synthetic current-source bindings instead of changing an old proof.
Other active route applications were not renewed.

The generated candidate is under `generated/switchyard-sol-high-candidate`.
The installed runtime and user configuration were not changed. Commit, push,
guarded deployment, paid routing-quality evaluation and native certification
remain separate release work. This turn consumed no provider quota.
