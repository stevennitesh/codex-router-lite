# Context ownership

Read when editing instructions, documentation, or runtime prompt assembly.
`AGENTS.md` is the small repository entry map. It routes likely tasks, especially
model/endpoint additions, to current guides; it is not an operations manual.

## Repository context

- Architecture owns product boundaries, source ownership and common verification.
- Model onboarding owns the integration path; endpoint guides own measured route rules.
- Debugging owns diagnosis; compatibility maintenance owns app/upstream refresh;
  installation and Switchyard guides own their runtime transactions.
- The engineering contract owns engineering discipline. Tracker and domain guides
  are conditional; ordinary endpoint work does not require a tracker or new ADR.
- README is the user-facing overview and links to maintainer entry points.
- Active delivery plans are reached through the affected component guide, not
  loaded globally. Plans own proposed behavior; maintained guides describe
  implemented behavior. Reconcile both at delivery acceptance and retain one
  active plan/handoff per workstream. Completed records remain historical.
- [History](../history/README.md) contains dated investigations and review evidence.
  Mark each record as historical when opened directly. Keep status, test counts,
  candidate commits and deployment anecdotes out of maintained instructions.
- `v2_agent/` retains machine-consumed exact-runtime evidence at its required paths.
  Its records are historical proof for named identities, not current operating rules.
- `generated/` is disposable scratch evidence, never a required context pointer.

Keep one authoritative owner for each rule, with concrete task triggers on inbound
links. When moving a document, preserve useful evidence and repair inbound and
relative links. Audit unlinked Markdown and instruction-bearing configuration too.
Do not replace current contracts with conclusions from an old investigation.

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
| Switchyard classifier | `config/switchyard/routes.template.toml`; [policy](../../config/switchyard/README.md#routing-policy) |
| Optional named worker | `config/switchyard/switchyard_worker.toml`; installed only when requested |

For missing instructions, trace selection, catalog/config generation and the actual
task's received messages. Presence in a source file or another task does not prove
delivery to this task. Do not patch the Responses proxy to duplicate native prompt
assembly. A runtime instruction change needs behavior verification and authorized
installation; editing these maintainer documents changes repository context only.
