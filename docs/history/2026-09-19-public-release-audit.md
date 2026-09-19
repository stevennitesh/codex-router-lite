# Pre-public history and repository audit

Historical release-readiness evidence from 2026-09-19. This record is not a
current operating instruction or a substitute for scanning a later history.

Gitleaks 8.30.1 was downloaded from its official GitHub release and verified
against the release checksum. After refreshing every origin branch and tag, the
scanner covered their full reachable Git history at Router Lite commit
`67ac75a4`: 1,263 commits and approximately 22.55 MB.

The scan reported four generic-key findings, all in test fixtures:

- two overlapping matches on the fixed RFC-style WebSocket handshake nonce in
  `test/responses-websocket.test.mjs`;
- one synthetic bearer credential used only by an authenticated transport test
  in `test/routing.test.mjs`; and
- one explicitly synthetic provider key in an upstream routing fixture.

The matches were fixed synthetic test values, not retained credentials.
No secret was copied into this record. Re-run a full-history scanner after any
history rewrite or before publication if the reachable refs change.

## Refreshed history scan

After fetching origin branches and tags, Gitleaks 8.30.1 (again verified against
its official release checksum) scanned all locally reachable refs with
`gitleaks git . --log-opts="--all" --redact` at HEAD
`0f8ed943a4dd1d2da671a565548db765a385c65a`. This broader scan covered 1,430 commits
and 23,975,096 bytes. It reported the same four synthetic fixture findings listed
above; their source contexts were reviewed again. No additional finding appeared.

A separate directory scan of the candidate's tracked and nonignored new files
covered approximately 2.94 MB and reported only the two overlapping WebSocket
test-nonce findings. Ignored local environments and credentials were not copied
into that candidate snapshot.

This records a history scan, not a blanket release clearance. Subsequent candidate
edits and their final publication commit are not covered by this HEAD identity.
Scan the final publication SHA after committing; record that result outside the
commit being scanned (for example in release evidence) to avoid a self-referential
cycle of evidence-only commits. Never change visibility on the strength of an
older scan alone.
