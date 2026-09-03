# Security

All Router, LiteLLM, and Switchyard listeners bind to loopback. Codex reaches Router through a random capability in the managed local URL. Internal hops use separate protected capabilities.

Native Codex requests retain Codex authorization and account headers. OpenRouter requests never receive the caller's authorization, ChatGPT account ID, installation ID, residency headers, or FedRAMP headers. The OpenRouter hop replaces them with the one protected provider key.

Switchyard is the only external routing exception. It is a local, capability-protected hop that preserves native Codex authorization for the native model it selects. It must strip the Router capability before its upstream request and must not log authorization, account data, route prompts, or unredacted decisions.

Protected state uses owner-only ACLs. Do not put credentials in source, config JSON, command arguments, logs, fixtures, support text, or generated route files. Treat the full managed loopback URL as sensitive.

Do not expose a listener on `0.0.0.0`, tunnel it, or place it on a shared network. Loopback capabilities do not protect against malicious code already running as the same Windows user.

Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/stevennitesh/codex-router-lite/security/advisories/new). Do not include secrets, full prompts, response bodies, or unredacted logs in a public issue.
