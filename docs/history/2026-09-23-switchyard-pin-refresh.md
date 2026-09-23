# Switchyard pin refresh - 2026-09-23

Historical source-review evidence, not live deployment status. Current authority
remains `config/switchyard/source.lock` and the active Switchyard integration guide.

## Reviewed update

- Previous upstream base: `ee3715d10ad3e43a2d6f2efc6c4c7a0964b00877`.
- New upstream base: `70f277e094981706854f05674da2f2ec939ac443`.
- The interval contains 31 upstream commits.
- PR #762 remains open and unmerged at source head
  `92c84a0ca6dddcad1ee2a894f61642b42093b0b8`; its five commits were
  rebased deliberately onto the new base rather than replaced with an upstream
  approximation.
- Rebasing preserved current upstream Plan/Execute and Stage Router structure while
  retaining the TypeSafe/Jev classifier contribution.

The review specifically checked upstream changes affecting configured HTTP-header
validation, routing-call accounting, tool-free Responses preservation,
cross-provider identity handling, fragmented tool names, translation capability
coverage, and `message_hash_fallback` with `classify_trigger = "user_turn"`.
Those changes are inherited where applicable. Router Lite does not adopt upstream
Plan/Execute or Stage Router as a new routing policy.

## Rebased Router compatibility layer

The Router compatibility delta replayed without source conflicts after the PR
rebase. Full integration tests exposed two TypeSafe server fixtures that expected
the Router-derived observation marker while bypassing local-hop authentication.
The fixtures were corrected to use the production capability boundary; the
forward-auth implementation itself remained unchanged.

Canonical identities:

- PR #762 patch SHA-256: `4d3ee0c37005276abb6613e34acfa1188b358119fa233245a4e6dd48b80ff3b6`.
- Router compatibility patch SHA-256: `539ab2ba5a7def69fd081b0b472fa7de656d946b6b32d57e497a8e539f978967`.
- Rebased PR tree: `c034a40abe93133fff8d44c2c421313057e1ca23`.
- Combined candidate tree: `658f6801d574a7534a6a1dd9b70b94140fcdff52`.
- Release `switchyard-server.exe` SHA-256: `859d1e1145ac63b8bb4acef92c365368a85ad5ed4fa1eb5f48a2b96e7efbe3ed`.

A clean replay of the two checked-in patches from the new upstream base matched
the verified combined candidate tree exactly.

## Verification

Using Rust 1.96.1, the exact layered candidate passed:

- `cargo fmt --all --check`;
- `cargo clippy --workspace --all-targets -- -D warnings`;
- the maintained package test set for the LLM client, libsy, runner, server,
  translation, and TypeSafe client; and
- `cargo build --release -p switchyard-server`.

Router Lite's full validation and dependency audit also passed after the pin and
patch refresh.

## Deployment disposition

This record does not claim a live Switchyard upgrade. No managed runtime was
replaced and no v2 proof was renewed as part of the source refresh. Runtime-bound
certification must be generated separately if this candidate is deployed.
