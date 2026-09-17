# Domain docs

**Configured layout:** single-context.

## Route

When domain meaning or an accepted decision affects the task, read the relevant
parts of root `CONTEXT.md` and `docs/adr/`, when present. Preserve their terminology
and distinguish accepted decisions from proposals and observed implementation.

Missing records are not automatically setup blockers. Resolve needed meaning
from its owning source or the user. Capture domain content only within the
authorized task; this route does not supply that content.

In this pack, shape-work owns domain clarification and accepted context/ADR
reconciliation. Repo-bootstrap configures this route; it does not invent domain
content. Suggest `$shape-work` when this clarification is needed; use it when
the user requests that workflow. Reading existing domain records does not invoke
it. Resolve the named skill from the current available skill catalog when invoked;
if unavailable, report that access gap without blocking unrelated work.

For Router implementation meaning, begin with [architecture](architecture.md) and
the affected endpoint guide. These own current behavior; the optional context/ADR
layout above does not require creating records for routine endpoint work.
