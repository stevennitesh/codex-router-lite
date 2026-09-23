# Native discovery capability decision, 2026-09-22

This record preserves the version-specific evidence behind the maintained
[native Codex](../agents/native-codex.md) static-catalog rule. It is historical
compatibility evidence, not current runtime authority.

The repository resolver selected installed `codex-cli 0.155.0-alpha.9.2`. Its
generated app-server schema exposes `model/list`, and an isolated strict-config
app-server using a protected disposable home proved that root
`model_catalog_json` carries rich reasoning, modality, multi-agent and
service-tier metadata. Rewriting that catalog while the same app-server remained
alive left consecutive `model/list` results on the original model, establishing
startup-only `StaticModelsManager` behavior for this build. No desktop picker
adoption was claimed.

This build did not support the proposed rich endpoint input. A custom provider's
`model_catalog_url` failed strict configuration as an unknown field. Without
strict configuration it was reported as ignored, made no request to the local
authenticated fixture and returned bundled models. The built-in `openai`
provider was reserved against user override, so substituting a custom provider
would not preserve the required native provider path.

The setting did exist in the bounded upstream source inspection at
`openai/codex` commit
[`639d2478`](https://github.com/openai/codex/tree/639d2478cc2e16d6ca715952d2e726a3aecc024e).
There it was a configured-provider field consumed by `OpenAiModelsManager`. The
client sent an authenticated GET to an absolute catalog URL with
`client_version`, expected native `{ "models": [...] }` data, accepted an ETag,
rejected redirects, limited the response to 1 MiB and used a five-second timeout.
API-key discovery additionally required `api_key_model_discovery`; ChatGPT and
configured-provider authentication used their provider identity. The retained
ETag supported an `X-Models-Etag` change trigger from a Responses stream rather
than an HTTP conditional GET. The upstream tests exercised a custom provider,
not a supported override of the built-in provider.

The decision was therefore to retain the managed static catalog and add no
endpoint or configuration migration. Compatibility maintenance may revisit this
only after an installed build recognizes the field and provides an approved
built-in-provider configuration path. The acceptance evidence must then include
same-process refresh across an in-flight catalog change and separate desktop
picker adoption.
