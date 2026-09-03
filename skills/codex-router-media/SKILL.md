---
name: codex-router-media
description: Generate video, music, speech, or images from a custom (non-OpenAI) model with the operator's connected MiniMax Token Plan through the Router media CLI. Use when the user explicitly asks to create media. Do not use for reading or analyzing existing media.
---

# MiniMax media generation

The Router media command resolves the connected MiniMax Token Plan credential
without exposing it. Each submission spends paid quota, so submit only what the
user explicitly requested and do not resubmit a timed-out task.

Resolve the installed Router source root from the install manifest, then use
`<sourceRoot>/bin/media` or `<sourceRoot>\model-router.ps1 codex media` on
Windows. Read `media --help` for the selected action instead of relying on a
copied flag catalog. Pass `--json` and an explicit `--out` path.

Video generation is asynchronous. If polling times out, run `media status`
with the returned task ID and the original `--out` path so completion writes to
the intended file. Do not submit the prompt again.

Return the saved local path; upstream download URLs expire. On a missing
credential or insufficient balance, relay the error and stop. Never inspect,
print, or pipe credential files or the command environment.
