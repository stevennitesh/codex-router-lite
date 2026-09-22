# Switchyard cache experiment procedure

This is the safe reproduction contract for the bounded experiment. The original
28-request result remains in
`2026-09-21-switchyard-cache-transition-experiment.json`. The one-off executable
was removed after review rather than retain code that can spend native account
requests.

Before a future run, build Switchyard from the commit and two ordered patches in
`config/switchyard/source.lock`, and verify the resulting patch and binary hashes.
Use an isolated temporary directory, free loopback ports, and three independent
random capabilities for Router caller authentication, Router internal
authentication, and Switchyard attribution. Write the capability-bearing route
configuration with `writePrivateFile`. Never include a capability-bearing URL in
an error.

Start isolated Router and Switchyard children with hidden windows and bounded
startup probes. Register both children and the temporary directory before any
operation that can throw. One outer `finally` must stop each child, escalate to a
bounded forced stop only if needed, and recursively remove that verified
temporary directory. A child `spawn` error is a bounded startup failure.

Run only after separate authorization for the native request budget. Keep the
28-request cap, disable native and empty-completion retries, and use fixed
synthetic content. The controlled-change sequence may change only the tool
description; instructions, input, tool identity/order, tier, and an intentional
`prompt_cache_key` remain fixed. Record current `git rev-parse HEAD`, the current
source-lock commit and patch hash, and label a caller-supplied binary hash as an
identifier rather than provenance proof.

At each serial request boundary, snapshot the observation record count. Associate
only newly appended records whose single association and request ordinal match
that request and whose attempt ordinals are contiguous from one. Mark zero new
records unavailable and conflicting or extra records ambiguous. Never shift all
later pairings by indexing the complete log. Sanitize the artifact before moving
it from the temporary directory, and retain missing fields as missing.
