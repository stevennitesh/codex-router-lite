# Development

The maintained product is Windows Codex compatibility with native Codex, OpenRouter GLM-5.3-Flash, Switchyard over native Codex models, and exact-route subagents v2.

Run the normal proof:

```powershell
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

`npm test` directly runs the retained test files. There is no secondary manifest or name filter. CI runs this same suite on Windows.

Keep route behavior exact. Do not add generic provider discovery, user model catalogs, alternate clients, non-Windows services, Router UI code, migration frameworks, fallback vision, search sidecars, or cross-provider failover.

`maintenance/windows-package.json` is the installed and release file list. Add a file only when the Windows runtime or managed Codex skills require it.

For installed Codex drift, read `docs/agents/compatibility-maintenance.md`. For Switchyard, then read `config/switchyard/README.md`. For v2 proof semantics, read `docs/SUBAGENT-CERTIFICATION.md`.
