# How Codex Router Lite works

Codex calls one loopback router. The selected model determines the next hop.

Native GPT models go to the native Codex backend with the caller's Codex authorization and account headers intact. `openrouter/glm-5.3-flash` goes through LiteLLM with a protected OpenRouter key; Codex credentials and account metadata are removed. `switchyard/auto` goes to a capability-protected loopback Switchyard process, which preserves native authorization for the native target it selects.

The installed Codex build owns the native catalog. Router merges exactly two routed entries into it. It does not keep a copied native model list.

Codex app functions cross a protocol boundary. Router flattens namespaced tools for routed models, keeps a request-local identity map, then restores the native namespace on returned calls. Encrypted subagent payloads use the same authenticated relay before external routing.

Windows Task Scheduler owns the background launcher. Service identity includes the launcher path, arguments, source root, generation, and live process. Updates use a guarded one-generation transaction with rollback.

Source pointers:

- Route metadata: `config/openrouter/*.json`, `config/switchyard/*.json`
- Catalog merge: `src/catalog.mjs`
- Request routing: `src/router.mjs`
- App functions and namespaces: `src/codex-app-tools.mjs`, `src/namespace-relay.mjs`
- Windows service: `src/service-windows.mjs`
- Installed files: `maintenance/windows-package.json`
