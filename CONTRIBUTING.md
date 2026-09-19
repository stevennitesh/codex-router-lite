# Contributing

Thanks for helping improve Router Lite. The project stays focused on the Windows
Codex desktop app and native CLI, with a small explicit set of routes.

Before opening a change:

1. Use [AGENTS.md](AGENTS.md) to find the maintained guide for the affected area.
2. Open an issue for a new endpoint, protocol change, or user-visible behavior so
   the compatibility and privacy boundaries are clear first.
3. Keep credentials, private prompts, response bodies, account identifiers, and
   unredacted logs out of issues, commits, fixtures, and pull requests. Report a
   vulnerability through [private reporting](SECURITY.md).

For code changes, install dependencies and run:

```powershell
npm ci
npm run verify
npm run audit:ci
```

CI runs the same verification command on Windows with Node 22.19.0 (the minimum)
and Node 24. The separate audit command retries only recognized infrastructure
errors, at most three attempts; vulnerabilities and exhausted retries still fail.
Run verification on the final candidate, including newly added files. For changes
to CI, packaging, or evidence hashes, also validate a fresh checkout: local files
can hide missing tracked files or Git line-ending conversion. Text evidence hashes
must use canonical line endings; executable/binary hashes must retain exact bytes.
Check the pushed commit's CI result before treating it as validated. An unrelated
follow-up commit does not resolve an existing red check.

Describe the behavior before and after the change, the exact route or boundary
affected, and the validation you ran. Live provider tests, deployment, and v2
certification are separate actions; do not claim them from offline tests.
