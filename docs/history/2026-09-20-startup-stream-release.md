# Startup, stream boundaries, and retry release

Historical acceptance record for Router `75ddd5d58c85f392f7b0c9c9f8ea8b1f4acc2f8f`.

The deployment includes credential-free native startup, bounded SSE lines,
strict WebSocket event termination, and preserved no-redirect policy on empty
completion recovery. The installed Switchyard binary and routing policy are unchanged.

[Exact-route evidence](2026-09-20-startup-stream-release-certification.json)
records all four native CLI parent/child runs. Each child computed 19+23 with
a native sandboxed tool, returned its first marker, and returned a second marker
after another encrypted handoff to the same child. All routed requests in these
windows returned HTTP 200. These are synthetic collaboration checks, not a GUI soak.

The installed Switchyard live verifier passed tool round-trip, current media
fallback and compaction checks. Its local report SHA-256 is
`03417bd5c8519ec22747517e5f6346899607e23a5acc1c9c7b99ad2d9ab59982`.
The two managed-startup tests passed in the normal Windows user context; they
substitute a health-only LiteLLM fixture and do not prove Python translation.

The later proof commit publishes v2 eligibility and binds this runtime candidate;
it is not a new deployed runtime. Prior acceptance remains historical.
