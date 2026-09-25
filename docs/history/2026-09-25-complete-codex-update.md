# Complete Codex 0.158 compatibility update - 2026-09-25

Historical compatibility and delivery-candidate evidence. Current authority
remains the maintained source, `maintenance/upstream-router.json`, and
`config/switchyard/source.lock`.

## Codex app and app-tool authority

The local Windows app is `26.924.1866.0`, the signed bundled CLI is
`codex-cli 0.158.0-alpha.2`, and the bundled
`codex-app-tools@openai-bundled` plugin is `0.1.5`.

Router Lite no longer ships a frozen Desktop app-tool schema snapshot. That
snapshot was not used by runtime routing and could become stale whenever the
Desktop host changed independently of the CLI. Runtime authority is now stated
exactly as implemented: the caller's request-local tool declarations, deferred
tool discoveries, and namespace metadata.

The old snapshot source and snapshot-only tests were removed from the product
and Windows package. Namespace behavior is tested with a synthetic
`mcp__codex_app` fixture that covers ordinary object schemas, a union-root
schema, worktree/artifact calls, and thread calls without claiming those
fixtures are a Desktop registry.

A local fake Responses provider was used with `codex exec` to inspect the
model-facing CLI request without a paid model call. It exposed zero Desktop app
tools even with the bundled plugin enabled, confirming that those capabilities
are injected by the Desktop host rather than owned by the CLI execution
surface. No private Desktop schemas were copied into Router source.

## Native catalog

The installed CLI's current catalog adds
`supports_reasoning_effort_updates`. The compatibility members used by
`switchyard/auto` are mixed: Astra advertises true while Sol and Luna
advertise false. The composite route therefore projects false. External routes
also retain the conservative false value rather than inheriting a native donor
capability.

The current CLI parses Router's generated catalog successfully.

## Original Router upstream

The original-Router review baseline remains current at
`9fb6440d9f310ce03b28e9b4eaeaf3b970b2703f`; no commits remained pending at
the final compatibility refresh. The Windows hidden-launcher fix was integrated
earlier in this update, including explicit `//E:VBScript` selection and safe
recognition of the immediately previous Router-owned task action.

## Switchyard upstream refresh

Switchyard was deliberately refreshed from
`70f277e094981706854f05674da2f2ec939ac443` to current upstream
`9cf6fadfc60bfdf59ee61bf8a14226807c2540bc`.

PR #762 source head remains
`92c84a0ca6dddcad1ee2a894f61642b42093b0b8`. Its five commits were rebased
onto the new upstream source, preserving current upstream Plan/Execute and
translation changes. Router Lite's compatibility layer replayed cleanly on top.

Verified identities:

- rebased PR #762 head:
  `26998ec55b817d6e3873e5a92b25f9cab3690f10`;
- combined compatibility head:
  `a30a5509ba665fabff46e9824d01c1526f4173ae`;
- combined candidate tree:
  `d2488ccea57c80f374f44fba7a806dc7125d77a4`;
- PR #762 patch SHA-256:
  `89ac116a528c7fbb7ece50119f89f3adde12eb87c4fe3f60159fd7f03b01aad1`;
- Router compatibility patch SHA-256:
  `0714847ebbb265086ee7c83a9078ec1c4c5f3e119be1101c4089750af3f3826c`;
- release `switchyard-server.exe` SHA-256:
  `c0b827252d73f0770dceeefdd512661cc870a118a2ce2e6e9f58f0345c36933b`.

A clean replay of both checked-in patches from `9cf6fadf...` matched the
verified candidate tree exactly.

Using Rust 1.96.1, the candidate passed:

- `cargo fmt --all --check`;
- `cargo clippy --workspace --all-targets -- -D warnings`;
- the maintained test set for the LLM client, libsy, runner, server,
  translation, and TypeSafe client; and
- `cargo build --release -p switchyard-server`.

The upstream Chat custom-tool and Anthropic-thinking translation fixes are
therefore inherited even though Router Lite's retained Switchyard path remains
Responses-to-Responses.

## Source verification

The combined Router branch passed the current Codex catalog check, Switchyard
fidelity checks, namespace relay regressions, the retained Router suite, product
boundary validation, and the production dependency audit.

This record describes the verified source candidate. Managed-runtime deployment
and any runtime-bound certification are separate evidence generated after the
merge.
