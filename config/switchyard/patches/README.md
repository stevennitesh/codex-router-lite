# Switchyard patch notice

The patch files in this directory are source-form derivative material for the
exact NVIDIA NeMo Switchyard revision recorded in `../source.lock`.

- `switchyard-typesafe-pr-762.patch` preserves the reviewed upstream pull-request
  contribution used by Router Lite.
- `switchyard-codex-compat.patch` contains Router Lite modifications for native
  Codex compatibility, local-hop security, routing identity, and diagnostics.

The underlying Switchyard source is Copyright (c) 2024-2026 NVIDIA CORPORATION
& AFFILIATES and is licensed under the Apache License, Version 2.0. Router Lite
changed the patched source. See [`../../../LICENSES/Apache-2.0.txt`](../../../LICENSES/Apache-2.0.txt)
and [`../../../NOTICE.md`](../../../NOTICE.md).

Do not edit the patch files without updating `../source.lock`, rebuilding the
candidate, and renewing runtime-bound evidence as required by the
[Switchyard maintenance contract](../maintenance.md).
