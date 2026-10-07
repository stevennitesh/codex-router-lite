# Codex Windows sandbox investigation, 2026-10-07

Historical investigation evidence. Native CLI certification subsequently passed
with a session-only MXC backend; the elevated backend's loaded-Node defect remains.
The installed helper is the signed original; the local source patch below is
not installed or accepted for live use.

## Configuration and runtime identity

The installed CLI reports `0.162.0-alpha.2`. Its setup helper has a valid
Authenticode signature and SHA-256
`E2C6C3A931AB0A6A40E0DB2B0A63A492B2006CB10A466A655B317F305A266F02`.

A fresh app-server `config/read`, including project layers, loaded
`sandbox_mode = "workspace-write"`, `approval_policy = "on-request"`, and
`windows.sandbox = "elevated"` without warnings. No managed sandbox constraint
or project override was present. The service feature resolves to its default,
false; the packaged provisioning service itself is installed and running.
These are separate facts: the feature value does not establish that provisioning
never contacts the service.

## Original loaded-file failure

Earlier native commands failed during runtime ACL validation with Windows error
32 on the running `node_repl.exe`. A controlled handle probe distinguished
`MAXIMUM_ALLOWED`, which failed, from `READ_CONTROL` and
`READ_CONTROL | WRITE_DAC`, which succeeded on the same loaded executable.

The exact release source opens root-only ACL targets with `MAXIMUM_ALLOWED`
before checking whether their ACL needs a grant. Requesting file data-write
access conflicts with the loaded image. The local
[source patch](2026-10-07-codex-sandbox-acl-fix.patch) keeps the existing directory
behavior and uses the existing minimal ACL handles for files. Its regression
failed with error 32 before the patch and passed afterward.

This is a reproduced upstream code defect, not evidence that replacing the
helper is necessary after supported sandbox recovery.

## Test side effect and later provisioning failure

The broader upstream sandbox suite passed 265 active tests, but those tests
were not isolated from the machine's live sandbox accounts. For example,
`unified_exec::tests::elevated_non_tty_cmd_forwards_env_output_and_exit` uses a
temporary Codex home while provisioning the shared sandbox accounts.
`provision_sandbox_users` generates new passwords, resets existing accounts,
and writes credentials to that temporary home. `WindowsSandboxAccountTestGuard`
only serializes integration tests; it does not restore live credentials or
coordinate with production through its separate lock. The temporary home alone
does not isolate this test's machine-wide effects.

The next live command reported that sandbox users were incompatible with the
installed marker. The attempted provision then failed opening `.sandbox-bin`.
The current directory is owned by the Windows user. Its protected DACL gives
the user `WRITE_DAC`, while SYSTEM and Administrators have Modify without
`WRITE_DAC`. The service's `ProvisionOnly` path requests `READ_CONTROL |
WRITE_DAC` through a no-reparse handle. This explains the service access failure;
changing model, provider, network, or approval settings cannot supply that
directory access.

Failed provisioning also left the setup marker empty. The fresh original-helper
probe at 06:04:55 UTC failed at this same directory boundary. Both sandbox
accounts' password-change timestamps match that provisioning attempt; no
passwords were read or retained in this report.

The earlier locally built helper installation was automatically reversed when
its live command failed at provisioning. The original hash was verified after
recovery and again during this investigation.

## Supported recovery attempt

Using the signed original, a fresh app-server invoked
`windowsSandbox/setupStart` with elevated mode and the real workspace. This
is the documented setup flow, with no model requests, sandbox downgrade,
manual ACL reset, account deletion, or alternate tool substitution.

The request started, but Windows canceled the administrator prompt. The
completion notification at 06:07:10 UTC reported
`orchestrator_helper_launch_canceled`, Windows error 1223. Thus the supported
repair did not run; this outcome does not prove that its helper code failed.
Completing that Windows prompt is required before judging this recovery path.

In a subsequent retry the user approved the Windows prompt. At 06:26:45 UTC,
the signed helper completed provisioning and committed a nonempty setup marker.
The subsequent ACL refresh still failed with error 32 on the running Node
executable. A fresh default-sandbox command at 06:28:15 UTC failed at that same
refresh boundary. The earlier account/provisioning obstacle has been separated
from the original loaded-file defect; the helper hash remained unchanged.

The user prefers signed binaries. The next controlled check retains the signed
original, waits for the desktop's Node executable to exit naturally, then calls
the app-server command API under the configured default sandbox. It starts no
model turn or Node REPL server and makes no model requests. A CLI model turn
would also need to avoid starting the explicitly configured Node REPL MCP
server for this test, since merely closing the desktop does not prevent CLI
MCP startup. Any passing result under this condition is a mitigation and causal
comparison, not a fix for concurrent desktop/Node execution.

After verifying real command execution, retry native certification through the
supported native CLI path while recording the execution conditions. A durable
fix for the loaded-file conflict should arrive in an official signed release.
Any further upstream account/process tests belong in a disposable Windows
environment, not the app user's live account environment.

## Reopened desktop and packaged runtime change

The detached command-only check expired at 07:09:11 UTC while the Node runtime
remained loaded. It started no sandbox command or model request, so it supplies
no evidence about command execution with Node stopped.

When the desktop was reopened later, the installed executable directory and
packaged helper had changed. The CLI still reports `0.162.0-alpha.2`; the current
helper is validly signed by OpenAI and has SHA-256
`AB7B6F92A7FC6CF75230FF1EF212D1FDC3C242391B77E6491B0DABA274174480`.
At 16:03:01 UTC, a fresh command-only probe with the desktop open failed with
error 32 on the new running Node executable during the same root-only ACL
refresh. This packaged change did not resolve the observed defect.

The rearmed controlled check pins the current packaged helper's identity and
signature, detects loaded Codex Node runtimes without relying on the old
versioned runtime path, and waits up to one hour for them to exit naturally.
An intervening Codex binary change aborts the check. It makes no model requests
and does not replace binaries or stop processes. Native certification remains
incomplete.

After the next desktop restart, the directly launched checker was no longer
running and had left only its waiting status. The desktop and its Node process
identities had changed, but no command result had been produced. This launch
did not survive app shutdown and cannot support a Node-stopped comparison.

The replacement checker was launched once through Windows Task Scheduler with
the current user's interactive token and limited privileges. Readback confirmed
its parent is `svchost.exe`, its task is running, and it is waiting for the loaded
Codex Node runtimes to exit. It deletes its unique temporary task on completion.
This is disposable diagnostic machinery, not a Router deployment component.

A separate zero-quota command comparison from that normal Windows environment,
with the desktop still open, failed at 16:35:54 UTC with the same Node-file
error 32. Merely launching the command outside the desktop process tree did not
remove the observed ACL conflict. Its temporary task was removed after the
result. The Node-stopped command comparison and native certification remain
pending.

At 16:39:53 UTC the independent checker observed zero loaded Codex Node REPL
processes and the configured default elevated workspace sandbox returned
`42` with exit code 0 and empty stderr. The helper retained its pinned hash and
valid OpenAI signature. The checker made no model requests and successfully
deleted its temporary scheduled task. This passes the command-only comparison;
it does not accept any route's native collaboration proof.

The exact source's `ensure_runtime_tree_readable` traverses the whole installed
Codex runtime tree on refresh, regardless of whether the current command uses
Node. Thus disabling a CLI's Node MCP server alone cannot avoid a file already
loaded by the desktop. A CLI run using this elevated backend must also keep the
desktop closed and avoid starting its configured Node-based MCP servers. The sandbox
and approval policy remain enabled. This is a recorded execution condition;
the concurrent desktop runtime bug still requires an official signed fix.

## Supported MXC comparison and native CLI acceptance

The installed release also supports `windows.sandbox = "mxc"`. Its exact source
uses a separate process security environment rather than the elevated helper's
runtime ACL refresh. A command-only app-server session with this override passed
at 17:03:20 UTC while the desktop and Node remained running. It returned 42 with
exit code 0 without a model request or binary replacement.

At 17:05:38 UTC a second scoped probe wrote a canary inside its workspace and
attempted to overwrite a fresh canary outside it. The outside write raised an
access-denied exception; independent readback confirmed that canary was unchanged.
The workspace write succeeded and the command returned 42 with exit code 0.
The probes removed their own canaries. Network access was enabled by the existing
workspace policy; these checks make no network-isolation claim.

The user chose to retain the persistent elevated setting and use MXC only for CLI
certification. A fresh native parent then used that session override, workspace-write,
and on-request approval. All six authorized exact-route children passed their real
shell call, two encrypted handoffs, first marker, and same-child continuation;
all 18 route requests completed with HTTP 200. The
[accepted evidence](2026-10-07-mxc-native-v2-certification.json) binds this run to
deployed Router `dedd5cf9baa112f7eabd8aeacdb0ae95ea48905d` and the current
signed helper. No global configuration or Codex binary was changed.

This establishes native CLI collaboration with MXC. It does not repair the elevated
helper or certify desktop elevated command execution. Optional MCP startup warnings
occurred during the CLI run; no MCP server tool was exercised, so this proof makes
no claim about those servers' health.

Sources: [official Windows recovery guidance](https://learn.chatgpt.com/docs/windows/windows-sandbox),
[official sandbox configuration values](https://learn.chatgpt.com/docs/config-file/config-reference),
[official setup API](https://learn.chatgpt.com/docs/app-server#windows-sandbox-setup-windowssandboxsetupstart),
and the locally inspected official source at
[`08a287137b1e11bf3566d53d6820b82177019f29`](https://github.com/openai/codex/tree/08a287137b1e11bf3566d53d6820b82177019f29/codex-rs/windows-sandbox-rs).

Private synthetic results remain under the ignored
`generated/codex-runtime-acl-fix` directory; they are not certification proofs.
