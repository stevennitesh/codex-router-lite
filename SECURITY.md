# Security

All Router, LiteLLM, and Switchyard listeners bind to loopback. Codex reaches Router through a random capability in the managed local URL. Internal hops use separate protected capabilities.

Native Codex requests retain Codex authorization and account headers. OpenRouter requests never receive the caller's authorization, ChatGPT account ID, installation ID, residency headers, or FedRAMP headers. The OpenRouter hop replaces them with the one protected provider key.

Switchyard is a local, capability-protected hop with two separate upstream paths.
Its Jev classifier sends bounded task text to OpenRouter's Decisions endpoint
using the protected OpenRouter key, without native authorization/account headers.
Currently the decision state contains the opening task and latest textual user
update. User media anywhere in retained history skips Jev and falls back to Sol;
media is not sent to the classifier. Assistant answers, tool-result payloads and
reasoning are excluded from decision state. User-authored text can still contain
sensitive information: a native answer model does not make classification local.

The selected native answer path preserves Codex authorization and conversation
content, including media. The local-hop capability must not reach upstream
providers. Do not log authorization, account data, route prompts or unredacted
decisions. Do not infer endpoint-specific retention enforcement from a provider's
general privacy documentation; the proposed follow-up has not established it.

Protected state uses owner-only ACLs. Do not put provider or native credentials
in source, config JSON, command arguments, logs, fixtures, support text, or
generated route files. The private Switchyard route file necessarily contains
the managed Router caller capability; follow its
[staging and ACL procedure](config/switchyard/maintenance.md#stage-and-validate).
The separate per-generation Switchyard hop capability must not be written there.
Treat the full managed loopback URL as sensitive.

Do not expose a listener on `0.0.0.0`, tunnel it, or place it on a shared network. Loopback capabilities do not protect against malicious code already running as the same Windows user.

Report vulnerabilities through [GitHub Private Vulnerability Reporting](https://github.com/stevennitesh/codex-router-lite/security/advisories/new). Do not include secrets, full prompts, response bodies, or unredacted logs in a public issue.
