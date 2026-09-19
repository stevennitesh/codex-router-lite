# Feedback and local changes

Router Lite is a maintainer-led personal project focused on the Windows Codex
desktop app and native CLI, with a small explicit set of routes. External pull
requests are not accepted. Bug reports and route or behavior proposals are
welcome through the privacy-safe issue forms, and you may fork the project for
your own changes.

Before opening an issue:

1. Use [AGENTS.md](AGENTS.md) to find the maintained guide for the affected area.
2. Use the proposal form for a new endpoint, protocol change, or user-visible
   behavior so the compatibility and privacy boundaries are clear.
3. Keep credentials, private prompts, response bodies, account identifiers, and
   unredacted logs out of issues, commits, and fixtures. Report a
   vulnerability through [private reporting](SECURITY.md).

Maintainers and people validating their own forks should install dependencies and run:

```powershell
npm ci
npm run verify
npm run audit:ci
```

CI runs the same verification command on Windows with Node 22.19.0 (the minimum)
and Node 24. The separate audit command allows at most three attempts when an
authoritative report is missing; vulnerabilities and exhausted retries fail.
Run verification on the final candidate, including newly added files. For changes
to CI, packaging, or evidence hashes, also validate a fresh checkout: local files
can hide missing tracked files or Git line-ending conversion. Text evidence hashes
must use canonical line endings; executable/binary hashes must retain exact bytes.
Check the pushed commit's CI result before treating it as validated. An unrelated
follow-up commit does not resolve an existing red check.

When reporting a bug or proposal, describe the behavior before and after, the
exact route or boundary affected, and any safe validation you ran. Live provider
tests, deployment, and v2 certification are separate actions; do not claim them
from offline tests.
