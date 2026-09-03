# Security model

The router has its own trust root separate from Codex's: a random caller key,
an internal service key, a private state directory, per-provider credential
files, and a dedicated service identity and port range. Kimi OAuth is the
intentional exception: the router reuses the official Kimi CLI session under
`~/.kimi-code`.

## Credential separation

Codex Router keeps every credential class on a distinct path:

- ChatGPT/Codex authentication is allow-listed only for native GPT, image,
  standalone web-search, and the authenticated local Switchyard hop. Switchyard
  is loopback-only and also requires a per-generation Router capability; it
  preserves the native authorization envelope for its selected native route and
  never logs or substitutes those headers.
- Kimi Code OAuth is read from the official Kimi CLI directory and sent only to
  the Kimi Code managed endpoint.
- Kimi Platform API keys are sent only to the configured Kimi Platform endpoint.
- DeepSeek API keys are sent only to the configured DeepSeek endpoint.
- A GitHub Copilot fine-grained PAT is validated through GitHub's Copilot
  account endpoint and sent only to the GitHub-owned inference endpoint that
  account metadata selects.

External provider requests never receive ChatGPT account IDs, Codex
installation IDs, attestation headers, or the caller's authorization header.
The Switchyard exception terminates at the authenticated loopback process. The
ordinary loopback gateway uses a random internal key, which the final forwarder
replaces with exactly one provider credential.

No provider credential is written to the model registry, catalog, Codex config,
generated LiteLLM config, logs, or health responses. Codex config does contain a
random, local-only caller capability as part of the managed loopback URL. The
config, its backup, migration snapshots, and diagnostic output are therefore
protected or redacted.

## Local secret storage

Router state lives under `$CODEX_HOME/codex-router` by default. Treat these
categories as private rather than maintaining a filename inventory here:

- caller and internal service capabilities;
- every provider file declared by `credential.file` in `config/`;
- generated catalogs, route configs, discovery caches, selection state, and
  account/session metadata;
- install manifests, migrations, rollback snapshots, support bundles, and
  local proof records;
- the generated Switchyard runtime, route file, provenance, and routing history
  under `$CODEX_HOME/switchyard` unless an explicit runtime root is configured.

`src/paths.mjs` owns Router state paths, provider fragments own credential-file
names, and `src/switchyard-runtime.mjs` owns the Switchyard root. New state must
join the same private-file and ACL policy instead of being added to a prose
allowlist.

The router can read provider keys from process environment or compatible
legacy macOS Keychain services. The interactive helper writes protected local
files so the per-user background service can access them without copying
secrets into its service definition. Files use mode `600` on POSIX systems. On
Windows, the helper removes inherited ACL entries and grants access only to the
current user SID.

Installers deliberately do not copy API-key environment variables into launchd,
systemd, or Task Scheduler definitions. Environment-only credentials work for a
foreground router process, but background setup requires a protected file.
Compatible legacy Keychain lookup is a migration path only.

Kimi OAuth remains under `$KIMI_CODE_HOME` or `~/.kimi-code`; Codex Router does
not copy it into its own state directory.

Never commit the state directory, a provider credential, a Kimi credential file, or
a generated config from a live installation.

## Network boundary

The router, LiteLLM gateway, OAuth forwarders, API forwarder, and Switchyard
bind only to `127.0.0.1`. Every model route requires a random caller capability,
which Codex carries in the managed URL.
Internal gateway and forwarder routes require a separate random service key,
and credential-detail health responses are authenticated.
Model requests must use JSON; requests with browser-origin headers are rejected,
and the router sends no CORS permission headers. This remains compatible with
Codex API-key sessions that do not attach a bearer header to the loopback hop.

This blocks drive-by browser requests and processes running without access to
the user's protected files. It does not create a security boundary against
malicious code already running as the same OS user, which can generally read
that user's Codex config and process state. Do not change listeners to
`0.0.0.0`, tunnel the ports, or expose them on a shared network. These controls
are not internet-facing authentication.

Codex may include the request URL in its own error output. Treat the full URL as
sensitive even though it is loopback-only; redact the generated path before
sharing screenshots or logs.

API base URL overrides are trusted-user configuration. A malicious override can
send the matching provider credential to another server. Inspect background
service environment changes and never accept an untrusted registry override.

For GitHub Copilot, the account-selected inference endpoint is allowlisted to
HTTPS GitHub Copilot hosts before the token is sent. A base URL override is
trusted-user configuration and receives the same token, so it must be protected
like every other provider override. Validated account routing is cached briefly
in process memory and refreshed once after an upstream 401.

An install made with `--no-provider --no-discovery` (see
[docs/INSTALL.md](docs/INSTALL.md)) is verifiable in this frame: zero provider
credential reads or writes, zero Keychain lookups, zero reads of other CLIs'
OAuth or session files, zero reads of Codex's `auth.json`, no `codex login
status` spawn against the real `CODEX_HOME`, and no outbound provider or
native connection — traffic gets a local `503 router_idle_no_provider`. Every
credential reader funnels through the persisted `discovery-mode.json`
kill-switch. The one Codex spawn that remains during install is `codex debug
models --bundled`, which reads the binary's static model list, not
credentials.

## Configuration safety

The config manager:

- Writes only a marked `openai_base_url` and `model_catalog_json` block.
- Preserves `model`, `model_provider`, reasoning settings, profiles, and ChatGPT
  authentication.
- Refuses to replace an unmarked user-owned base URL or catalog.
- Creates `~/.codex/config.toml.pre-codex-router` before its first change.
- Atomically rewrites the config and restricts it to the current user.
- Recognizes and removes the earlier Kimi-specific managed block during upgrade.
- Snapshots recognized old service definitions and exact config before migration.
- Refuses unknown router catalogs and unrecognized origin URLs during update.

Review the scoped difference with:

```sh
diff -u ~/.codex/config.toml.pre-codex-router ~/.codex/config.toml
```

## Dependency and release hygiene

LiteLLM is version-pinned because it processes prompts, tool calls, streams, and
provider responses. Node dependencies are locked by `package-lock.json`. CI runs
syntax, audit, and route/state tests on macOS, Linux, and Windows. Tagged source
archives include SHA-256 checksums and GitHub build-provenance attestations.

The convenience bootstrap commands track the repository's default branch. Users
who need a fully reviewable or pinned install should download a tagged archive,
verify `SHA256SUMS` and its provenance, inspect it, and run the local installer.

Model discovery is read-only and never edits the registry. The live compatibility
suite requires both `--live` and `--yes` because it sends prompts and consumes
provider quota. Repository workflows receive provider keys only through GitHub
Secrets; pull-request CI never receives them.

Support bundles exclude logs by default and are never uploaded automatically.
The optional redacted log tail can still contain private prompt or response text
and must be inspected before sharing.

Network-facing error handlers do not return or log raw exception text. Detailed
credential state is available only through authenticated local health checks and
the redacted doctor/support workflows.

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/duolahypercho/codex-router/security/advisories/new).
Do not include technical vulnerability details, access tokens, API keys,
credential files, full prompts, response bodies, or unredacted logs in a public
issue.
