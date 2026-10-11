# Switchyard Sol High deployment and certification, 2026-10-09

Historical release evidence, not current runtime authority. Dates and observed
timestamps in the linked records use UTC.

## Deployed source and runtime

Commit `952339029991e9afb063758b083a195e56a61c41` contains the Switchyard
audit repairs, GPT-6.1 Sol High policy and OpenRouter reasoning-alias repair.
It was pushed and deployed through the independent checkout transaction.
The worker accepted the deployment at `2026-10-09T05:08:57.1532699Z`.
All eleven acceptance checks passed: Router and Switchyard health, task and
process ownership, clean candidate, install manifest, Doctor, protected
endpoints, provenance, installed hashes and installed catalog parsing.

The new Switchyard binary has SHA-256
`c8f0434a224a84a7db769f1eb0ca392e6f4159fc5e4e87fa330cfff7dca5dca1`.
The private installed routes have SHA-256
`9d69181ce81c689050ddf4c4fb6bc6785aef01e534a87bf665c9e925c80fc97a`.
Their pinned upstream, ordered patches and template identities are recorded in
the accepted application. The Sol target, local fallback and native compaction
use `gpt-6.1-sol` at `high` effort; Luna and Astra targets retain their policies.

Normal drain succeeded without forced replacement. The transaction reused the
single recovery set retained from the preceding release, whose original Router
revision was `a3fe490d6e7cbdc9fb5b27aeb2c4515860680370`. No Codex binary or
persistent Windows sandbox setting was replaced.

## Verification and routing quality

The source candidate passed 673 Node tests with no failures or skips and
installed-Codex parsing of 17 models. The locked Rust build passed formatting,
workspace Clippy and 866 unit, integration and documentation tests, with no
ignored tests. Eight offline classifier-input fidelity cases passed. The
[candidate CI run](https://github.com/stevennitesh/codex-router-lite/actions/runs/37886921869)
passed both Windows Node jobs and the Python dependency audit.

The [frozen quality evaluation](2026-10-09-switchyard-sol-high-routing-quality.json)
made exactly 40 paid classifier decisions, with no answer calls or retries.
All 20 development cases and 20 holdout cases were acceptable; exact selection
was 19/20 and 20/20 respectively. All ten promotion gates passed, with no severe
under-routes or expensive over-routes. The provider build remained
`typesafe/jev-1.13-20260917`. These are authored synthetic cases, not an
independent dataset or a claim about arbitrary production workloads.

## Native route renewal

The [reviewed certification batch](2026-10-09-sol-high-release-certification.json)
renewed GLM StreamLake, GLM Together, DeepSeek Together, DeepSeek DeepInfra,
Pareto and Switchyard against the deployed commit. All five required checks
passed for each exact route. All 18 native child requests and six separate
streaming requests returned HTTP 200. Every child produced sandboxed command
output `42`, received two encrypted handoffs and returned both markers in the
same child thread. Completed-turn cleanup cancelled no active turns.

Switchyard's five supplemental client requests verified an ordinary tool
round-trip, native image control, image fallback and native compaction. All
completed with HTTP 200. Tool affinity stayed on Luna Max. Image fallback took
the Sol High path with zero classifier-provider calls, and compaction bypassed
the classifier. Each phase used its own evidence attribution; no foreign request
was counted. The smoke runner reported no required failures.

The certification parent was changed from GPT-6.1 Sol Medium to High before the
run; its 13 nearest runner tests passed. This maintenance-only correction does
not change the installed Router handlers. The accepted proofs and v2 eligibility
are committed after observation; their bindings continue to name the deployed
candidate above rather than a later evidence commit.

The run used Codex CLI `0.162.0-alpha.2`, session-only MXC, workspace-write and
on-request approval. It does not certify the desktop's elevated sandbox or
arbitrary MCP tools. Persistent `windows.sandbox = "elevated"` was retained.
The previous Sol Medium application remains unchanged in its historical directory.
Raw transcripts, session identities, provider bodies and capabilities stay local.

## Recovery retention

After proof acceptance, Router's process ownership was verified against the
active checkout, the scheduled task was running and full health returned HTTP
200 with no degraded components. The clean disposable recovery checkout, its
retained runtime backup and this deployment's staging directory were then
removed. Older unrelated recovery checkouts and local evidence were preserved.
