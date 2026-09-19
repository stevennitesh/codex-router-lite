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

None matched a known provider-token prefix or represented a retained credential.
No secret was copied into this record. Re-run a full-history scanner after any
history rewrite or before publication if the reachable refs change.
