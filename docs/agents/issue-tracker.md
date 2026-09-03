# Issue tracker: GitHub

Issues and specifications live in GitHub Issues.

## Configuration

**PRs as a request surface:** no.

**Close implemented items:** yes.

**Parent / child mode:** native-sub-issues.

**Dependency mode:** native-dependencies.

## Operations

Use the GitHub connector when it exposes the required operation. Otherwise use
`gh` after resolving the repository from `git remote -v`.

- **Publish:** create an issue.
- **Fetch:** read the issue body, comments, labels, state, assignee, and
  relationships.
- **Comment:** add an issue comment.
- **Label:** add or remove a configured label.
- **Close:** add any skill-owned closing comment, then close when configured or
  explicitly directed.
- **Relationships:** use configured native sub-issue and dependency operations,
  or their verified REST endpoints when the connector lacks them.

Resolve the operation and its independent read-back route before the first
external mutation. GitHub issues and PRs share one number space, so resolve an
ambiguous `#<n>` as a PR first and then as an issue.

## Representation

- Content lives in the issue body and comments.
- Category and state use values from
  [`triage-labels.md`](triage-labels.md).
- Parent and child links use the configured parent / child mode.
- Blocking links use the configured dependency mode.
- An active claim uses the assignee.

Do not switch relationship representations during one publication. Closing or
superseding a blocker must not expose a dependent as ready while it remains
blocked.

## Mutation read-back

After a mutation, refetch the target and affected relationships. Verify the
intended body, labels, state, assignee, comments, and open or closed state. After
a failed or indeterminate command, refetch before deciding whether to retry.
Report any observed partial result and the safest recovery.
