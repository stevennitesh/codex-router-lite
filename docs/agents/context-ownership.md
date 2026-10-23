# Context ownership

Read when editing instructions, documentation, or runtime prompt assembly.
[AGENTS.md](../../AGENTS.md) is the repository entry map. Load the guide for the
task; runtime prompt sources below are conditional product owners.

## Repository context

- The [system specification](architecture.md) owns product boundaries, invariants,
  source ownership and [verification scope](architecture.md#verification).
- [Model onboarding](model-onboarding.md) owns the integration path; endpoint
  guides own measured route rules.
- [ChatGPT Web models](../CHATGPT-WEB.md) owns setup and everyday use;
  [Web integration](web-integration.md) owns saved context, native tools,
  observation, Stop and adapter compatibility.
- Debugging owns diagnosis; compatibility maintenance owns app/upstream refresh;
  installation and Switchyard guides own their runtime transactions.
- [Tracker guidance](issue-tracker.md) is conditional; ordinary endpoint work
  does not require a tracker or new ADR.
- README is the user-facing overview and links to maintainer entry points.
- Portable technical plans and design documents may be tracked when they contain
  durable problem statements, constraints and acceptance evidence without worker
  orchestration. Component guides describe maintained behavior rather than
  routing temporary execution plans. Reconcile plans with their maintained owners
  at delivery acceptance. Completed records remain historical.
- [History](../history/README.md) contains dated investigations and review evidence.
  Mark each record as historical when opened directly. Keep status, test counts,
  candidate commits and deployment anecdotes out of maintained instructions.
- `v2_agent/` retains machine-consumed exact-runtime evidence at its required paths.
  Its records are historical proof for named identities, not current operating rules.
- `generated/` is disposable scratch evidence, never a required context pointer.
  Private filesystem paths, skill hashes, checkout custody, temporary
  authorization and live worker coordination belong only in ignored scratch or
  the active task conversation. Keep them out of product guides, delivery plans
  and historical records; retain only durable technical scope, gates and evidence.

Repository context maintenance uses the applicable context-hygiene or
repo-bootstrap skill. Keep durable requirements at the owners above; preserve
history and repair the affected reading paths when moving or retiring a source.
A documentation cleanup does not install shipped skills, change model eligibility,
spend provider quota or start deployment.

## Runtime instructions

These are product behavior, not extra repo instructions to preload while coding:

| Surface | Authority / loading condition |
| --- | --- |
| Native model base instructions | Installed Codex catalog; `src/catalog.mjs` derives routed behavior without replacing native entries |
| Route-selected base profile | `src/instruction-profiles.mjs`, selected by route `instructionProfile` |
| External-model tool failure recovery | `src/instruction-profiles.mjs`, appended by catalog generation to both external prompt surfaces; native profiles retain their own instructions |
| Root delegation wait/cleanup hint | `src/config-manager.mjs` writes managed `multi_agent_v2.root_agent_usage_hint_text`; [native behavior](native-codex.md) |
| Routed app/tool skills | `skills/*/SKILL.md`, installed by `src/skills-install.mjs`; companion skills are task-conditional |
| Routed child task and completion guidance | `src/codex-agent-catalog.mjs`, generated into managed agent definitions during catalog refresh |
| Web bridge protocol, instructions and incremental delivery | `src/web-runtime.mjs`; [context delivery](web-integration.md#instruction-delivery-and-compaction) |
| Switchyard classifier | `config/switchyard/routes.template.toml`; [policy](../../config/switchyard/README.md#routing-policy) |
| Optional named worker | `config/switchyard/switchyard_worker.toml`; installed only when requested |

For missing instructions, trace selection, catalog/config generation and the actual
task's received messages. Presence in a source file or another task does not prove
delivery to this task. Do not patch the Responses proxy to duplicate native prompt
assembly. A runtime instruction change needs behavior verification and authorized
installation; editing these maintainer documents changes repository context only.
