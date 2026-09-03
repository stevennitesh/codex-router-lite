# Attribution

This project uses the merged-model-catalog and built-in-provider routing
pattern demonstrated by [opencodex](https://github.com/lidge-jun/opencodex).
The implementation in this repository provides a registry-driven local router
for Codex with provider-specific adapters and supervised local integrations.

`opencodex` is distributed under the MIT License. Copyright (c) 2026
opencodex contributors.

The optional Switchyard runtime is built from a pinned revision of
[NVIDIA NeMo Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) with the
checked-in Codex compatibility patch. Switchyard is distributed under the
Apache License 2.0. Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES.
Modified files are identified by the canonical patch under
`config/switchyard/patches/`; the installed binary is generated output.

The `devin-cli` provider's understanding of Cascade's Connect RPC surface —
the service path, the doubled `Basic` credential, and which request fields a
turn must carry — follows
[devin-2api](https://github.com/leookun/devin-2api), distributed under the MIT
License. Copyright (c) 2026 devin-2api contributors. The protobuf field
numbers in `src/devin-proto.mjs` are transcribed from the descriptor set
embedded in Cognition's own `devin` binary; no code was copied.

This is an independent community project. It is not affiliated with or
endorsed by OpenAI, Anthropic, Moonshot AI, the Kimi Code team, DeepSeek,
OpenRouter, or Cognition AI. GitHub and Copilot are trademarks of GitHub,
Inc.; this project's GitHub Copilot integration is not endorsed by GitHub.
Devin and Windsurf are trademarks of Cognition AI, Inc.

The GitHub Copilot tray mark is adapted from Primer Octicons' `copilot-24.svg`,
distributed under the MIT License. Copyright (c) 2026 GitHub Inc.
