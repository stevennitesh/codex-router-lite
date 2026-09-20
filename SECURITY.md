# Security

All Router, LiteLLM, and Switchyard listeners bind to loopback. Codex reaches Router through a random capability in the managed local URL. Internal hops use separate protected capabilities.

Native Codex requests retain Codex authorization and account headers. OpenRouter requests never receive the caller's authorization, ChatGPT account ID, installation ID, residency headers, or FedRAMP headers. The OpenRouter hop replaces them with the one protected provider key.

Switchyard is a local, capability-protected hop with two separate upstream paths.
The checked-in Jev classifier sends bounded task text to OpenRouter's Decisions
endpoint using the protected OpenRouter key, without native authorization/account
headers. The decision state contains only the latest genuine user turn. For a
canonical encrypted native child handoff, Router asks the native account-scoped
relay for the current task plaintext and gives Switchyard a request-local
classifier projection. The projection has a five-second waiter deadline, shares
the bounded account-scoped cache and coalescing path, and is removed before
Switchyard decodes, retains, logs, or forwards the native request. Caller-supplied
projection fields are stripped. Relay failure, malformed output, unsupported
content, or an oversized state bypasses Jev and falls back to Sol. In ordinary
plaintext history, empty and control-only pseudo-user items are skipped and the
most recent genuine user turn can still be selected. For child handoffs only the
final item is considered, and a prior child assignment is never substituted.
Assistant answers, tool-result payloads and reasoning are excluded from decision
state. User-authored text can still contain sensitive information: a native answer
model does not make classification local.

The selected native answer path preserves Codex authorization and conversation
content, including media. The local-hop capability must not reach upstream
providers. Do not log authorization, account data, route prompts or unredacted
decisions. OpenRouter documents account and key guardrails that can require
zero-data-retention routing for model groups, but the Decisions documentation
does not establish how those controls are enforced on this exact alpha endpoint.
This repository therefore does not claim endpoint-specific ZDR. A dedicated key
or guardrail remains an account-side option requiring separate authorization and
verification.

Protected state uses owner-only ACLs. Do not put provider or native credentials
in source, config JSON, command arguments, logs, fixtures, support text, or
generated route files. The private Switchyard route file necessarily contains
the managed Router caller capability; follow its
[staging and ACL procedure](config/switchyard/maintenance.md#stage-and-validate).
The separate per-generation Switchyard hop capability must not be written there.
Treat the full managed loopback URL as sensitive.

Do not expose a listener on `0.0.0.0`, tunnel it, or place it on a shared network. Loopback capabilities do not protect against malicious code already running as the same Windows user.

Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/stevennitesh/codex-router-lite/security/advisories/new). Do not include secrets, full prompts, response bodies, or unredacted logs in a public issue.
