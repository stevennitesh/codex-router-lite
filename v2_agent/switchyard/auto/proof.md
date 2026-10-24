# switchyard/auto v2 application: pending source candidate

The checked-in route declares subagents v1 while the changed Switchyard
compatibility patch awaits a fresh exact-runtime proof. All runtime observations
and all five required checks are pending. Offline qualification does not establish
native collaboration acceptance.

This source transition does not change the installed runtime or its recorded
acceptance. The [previous accepted proof](../../../docs/history/2026-10-24-switchyard-previous-proof/proof.md)
and its [exact runtime binding](../../../docs/history/2026-10-24-switchyard-previous-proof/proof.json)
are archived unchanged; those observations do not certify this candidate.

## Route

- Routed slug: `switchyard/auto`
- Upstream model ID: `gpt-6.1-sol`
- Router version and tested commit: pending
- Codex version/build and execution surface: pending
- Test date and deployed runtime binding: pending

## Evidence

| Check | Result |
| --- | --- |
| Streamed text and completion | pending |
| Actual native tool and output | pending |
| Encrypted parent-to-child relay | pending |
| First marker | pending |
| Same-child follow-up | pending |

## Official sources

- https://github.com/NVIDIA-NeMo/Switchyard/blob/fbabf51c62793ed0f6af042b60e92ce1cfba083b/README.md

## Scope and reproduction

No deployment or live certification of this candidate has been performed.
Follow [certification](../../../docs/SUBAGENT-CERTIFICATION.md#manual-desktop-or-v1-candidate-path):
validate and commit the v1 candidate, then deploy that clean commit only when
authorized. The authorized proof window may temporarily set source and catalog
eligibility to v2 without an intermediate commit. Publish accepted evidence and
the v2 declaration together in a later commit only after all five checks pass;
restore v1 and refresh the catalog if the run fails.
