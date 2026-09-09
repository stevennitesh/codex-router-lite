# Triage labels

Map these roles to repository tracker values. The mapping supplies vocabulary;
the consuming workflow defines readiness criteria and permitted transitions.
Direct coding does not require a tracker item.

## Category roles

| Skill-pack role | Tracker value |
| --- | --- |
| `bug` | `bug` |
| `enhancement` | `enhancement` |

## State roles

| Skill-pack role | Tracker value |
| --- | --- |
| `needs-triage` | `needs-triage` |
| `needs-info` | `question` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-human` |
| `implemented` | `implemented` |
| `wontfix` | `wontfix` |

A mapping does not establish that remote labels exist. Verify the relevant
values before an operation needs them. A state label alone does not prove
completion or remove an unresolved dependency.
