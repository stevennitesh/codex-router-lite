# ChatGPT Web models

This optional integration lets Router use ChatGPT in the Codex in-app browser.
Router owns the browser turn, its local MCP broker and the tunnel process. ChatGPT
requests tools through that broker; native Codex executes each declared tool with
its ordinary permissions and returns the actual result. Browser operations also
run through the current native JavaScript tool. No separate launcher or inference
controller is required.

This is unofficial browser automation. Configuration and offline checks do not
establish account-bound browser, tool, continuation or cancellation readiness.
Verify those through an actual Web conversation before relying on the route.

## Configure the browser integration

Use a signed-in ChatGPT account in the current Codex in-app browser. Register the
Router MCP connector with the official tunnel service, and retain its tunnel ID,
runtime key and exact connector identity. The connector's visible selection button
and attached chip must match the configured name and app ID.

Create a JSON configuration file with these safe fields. Replace the example
values with current observed paths, connector identities and account capabilities:

```json
{
  "runtimeModule": "C:\\absolute\\path\\official-browser-runtime.mjs",
  "pluginName": "Router local tools",
  "pluginAppId": "asdk_app_REPLACE_WITH_OBSERVED_ID",
  "pluginSelectionButtonName": "REPLACE_WITH_EXACT_CONNECTOR_BUTTON",
  "tunnelId": "tunnel_REPLACE_WITH_REGISTERED_ID",
  "tunnelClientPath": "C:\\absolute\\path\\officialtunnelclient.exe",
  "capabilities": {
    "solAvailable": true,
    "extraHighAvailable": false,
    "proAvailable": false
  }
}
```

`runtimeModule` is the current official public browser runtime module supplied by
the installed Codex browser skill. Router loads it through native Codex; it does
not vendor or hardcode a versioned module path. Both file paths must be absolute
and name existing regular files. `pluginAppId` must begin with `asdk_app_`, and
`tunnelId` must begin with `tunnel_`. Use the exact observed connector button name,
including any visible suffix. `capabilities` is a safe account observation used
for model publication; it is checked against the browser before sending.

An optional integer `mcpPort` selects a dedicated loopback port from 1 through
65535, separate from Router ports. Omit it to let the operating
system choose a free port. The schema accepts only the fields shown above and
`mcpPort`. Do not put runtime keys, cookies or account credentials in this file.

Save the runtime key at the hidden prompt, then configure the integration and refresh
the model picker:

```powershell
.\model-router.ps1 codex web tunnel-key set
.\model-router.ps1 codex web browser 'C:\absolute\path\web-browser.json'
.\model-router.ps1 codex refresh-catalog
.\model-router.ps1 codex web status
```

The key is stored in Router state as the owner-only
`chatgpt-web-runtime-key.secret` file. `set` never accepts a key argument or echoes
the value. The key needs Tunnels Read and Use permission in the tunnel's Platform
organization. After replacing a key for a running tunnel, restart Router so its
owned tunnel client loads the replacement. Inspect or remove it with:

```powershell
.\model-router.ps1 codex web tunnel-key status
.\model-router.ps1 codex web tunnel-key remove
```

Fully quit and reopen Codex, then choose a model ending in `(Web)`. Configuration
publishes the eligible model choices while preserving previous visibility choices;
it does not launch the browser or prove tool access. Router starts its loopback
MCP listener and official tunnel client when an enabled in-app configuration is
loaded at startup, or on its first Web request after configuration. It uses a
private tunnel configuration and owns their cleanup. Reconfigure paths and
observed connector details after an update changes them.

Tunnel readiness requires a successful hosted control-plane poll. The client's
local `/readyz` response alone does not establish authenticated polling. Rejected
poll credentials fail with `web_tunnel_auth_rejected`; replace the protected key
or correct its Tunnels permissions, then restart Router. Other polling failures
leave the tunnel unready rather than permitting a tool-dependent Web turn.

## Browser turns and tools

The in-app backend binds each native Codex conversation to one normal saved
ChatGPT chat, including across model and effort changes. Router stores the
conversation's chat URL and context checkpoint in its private local state. The
coding conversation remains in the signed-in ChatGPT account's history until
removed there. One native browser operation attaches the configured connector
when needed, selects and verifies the requested ChatGPT family and Power, then
sends the request. Selection is checked against the current page on every turn.
If the requested family is already selected, Router verifies its current Power
without expanding and reselecting the family. A family change first opens the
visible family list; collapsed rows remaining in the DOM are not click targets.
Follow-ups send the
native history added since the last confirmed Send. ChatGPT owns the saved
conversation's reasoning context. Codex retains its transcript and tool execution
records locally; storing or forwarding them does not request Codex inference.

Web-route native compaction selects source excerpts locally, without requesting
a model summary. Both standalone compaction and native V2 compaction stay local;
they do not generate a Web reply or request browser tools. This is separate from
the subagent protocol selector below. For an owned saved conversation, Router
records the delivery boundary and preserves genuinely undelivered native items.
V2 carries those exact items inside the readable checkpoint because Codex keeps
only the compaction output item. New material is never silently excerpted to fit
that carrier: compaction fails if it cannot fit. Continuing sends the new items
without repeating a summary of history already delivered to ChatGPT. A first
attachment with readable compacted history still uses that checkpoint to seed
its new chat.

If the tab closes or Codex restarts, Router reopens the recorded chat URL in that
Codex conversation's browser and checks the previous reply's identity and text
prefix before continuing. If Stop preceded a readable answer, a confirmed
generation's unique latest turn can establish ownership in the recorded saved
chat instead. Recovery requires the confirmed generation checkpoint and matching
saved-chat proof.
Tab IDs alone do not identify a chat. Reopening preserves the saved conversation;
it does not resend its full history or execute historical tool calls again. An
uncertain Send or unresolved native coding action blocks continuation until its
actual outcome is known. A deleted or inaccessible chat, a changed nonempty tab,
a user draft, missing ownership, unreadable history or inconsistent reply
evidence fails explicitly rather than silently starting a replacement chat.

Each confirmed Send owns one rendered logical turn. That turn can contain
commentary, tool activity and several assistant messages. Router reads the latest
answer within that turn; it does not bind the whole generation to its first
assistant message. Older turns and embedded tool widgets cannot establish a new
answer. Missing or ambiguous turn/message identities fail explicitly.

Bootstrap and ordinary continuation install a versioned browser helper in the
native Node REPL binding. Observation and final retention invoke that helper with
a small operation request instead of repeating its source. Its source digest,
frozen controller and exact binding are checked before invocation. A missing or
changed helper fails explicitly; ordinary continuation can restore it without
replaying Send. The helper runs in the native REPL, not injected page code.

Each reply snapshot retains mounted turn/message identities and order, while
reconstructing answer text and completion details only for the owned generation.
Recovery still reads the historical proof it needs. Independent control reads run
concurrently between navigation/ownership checks, and observations return control
without pausing between batched page reads. The separate final retention check,
broker activity checks, protected durable writes and Interrupt hook remain.

Native tool requests are delivered independently of final-answer readability.
Completion requires an idle owned browser turn, an answer after the latest tool
boundary, and unchanged broker activity across the completion read and final
delivery. A completed page with unreadable output or no post-tool answer ends
with a bounded error instead of waiting for the general generation deadline.

The site's explicit maximum-conversation-length notice and **Start new chat**
action permit a successor saved chat. Assistant prose, timeouts and generic
errors do not. Router transfers current readable Codex context once, retains the
previous saved chat URL and continues the same native conversation with fresh
tool authority. If the old chat already answered or ran tools, Router preserves
that work and defers transfer to the next native user turn. An incomplete answer
or uncertain action fails explicitly rather than replaying the request. A bounded
checkpoint cannot guarantee retention of every older detail; its loss notices
remain part of the handoff. A successor that also reports full fails rather than
creating an unbounded chain of chats.

The connector discovers only tools declared and allowed for the current native
Codex request. Its `codex_tools_list` operation accepts an optional `query` matching
the current wire name, native name, namespace or description, ignoring case.
Exact names rank first, followed by name prefixes, name substrings and description
matches. Omit the query for the full catalog. Focused results retain each selected
tool's complete current schema or custom grammar; discovery does not grant tool
authorization. Prefer a focused query for the tool needed by the current action.
It requests a tool by its exact identity, and Router returns that
request to native Codex for execution and approval. Router itself does not run
shell commands or bypass Codex approvals. Tool results return to the same active
browser turn before ChatGPT continues. Private turn tokens and the tunnel runtime
key are transport state and must not appear in answers or logs.

Native cancellation retires the exact Web turn and revokes further connector tool
access; cancelled or timed-out tool calls are not replayed. Router preserves the
session's tab identity and marks the verified tab for retention before generation.
The next turn reconciles the interrupted generation, stops it if necessary,
captures its partial reply and continues in that same chat. Stale cleanup cannot
stop a newer turn. Revocation does not undo
a tool that native Codex has already started. A missing or changed native rollout
prevents the runtime from asserting cancellation authority.

Immediate browser Stop needs both the interrupted conversation's native context
and enough time to confirm that its exact Stop button disappeared. Ordinary tool
calls receive canonical session/turn metadata and sandbox authority; a stock local
Interrupt hook supplies only the thread ID. A direct browser hook therefore cannot
recover that context by itself. The earlier direct-hook failure is recorded in
the [dated verification evidence](history/2026-10-17-web-saved-chat-verification.json).

The optional Router MCP adapter retains the actual originating browser operation's
metadata for fixed cleanup in the same official Node REPL child. It preserves
opaque sandbox and launcher values and refuses conflicting observed authority;
it does not infer newer host policy from the hook. A separately trusted user
Interrupt hook calls the adapter's own callback with a three-second timeout.
Bundled one-second callbacks keep their original messages and cancellation scope.
Cleanup waits for the active browser call's actual terminal callback, sharing
the existing three-second deadline with Stop and its readback. The remaining
allowance bounds both the injected call and its browser operations. A terminal
observation error releases that wait only for the already accepted matching
cleanup; the original error still reaches Codex. A timeout, cancellation of the
cleanup itself, or changed authority prevents further browser actions.
Stop must still read back hidden generation controls and retain the exact saved
tab before reporting success. Visibility checks use the remaining cleanup budget;
they do not impose a separate half-second acknowledgement limit or click Stop
again. A partial cleanup remains an explicit failure.

The unmodified official CLI adapter path has
[dated Stop and same-chat continuation evidence](history/2026-10-19-web-stop-adapter-verification.json).
The record covers the all-ordinary configuration after a normal Codex restart,
with the same saved chat, tab and binding retained. Its live check used one
Instant Web primary route; it does not individually certify every Web model.

To install the adapter, supply a local manifest identifying the signed official
CLI, Node and Node REPL executables, their hashes and signer identity, the browser
runtime module, and the existing MCP SDK package. `threadIds` restricts a trial;
`null` enables ordinary Web conversations. The adapter excludes subagent metadata.

```powershell
.\model-router.ps1 codex web stop install-adapter .\adapter-build-manifest.json
.\model-router.ps1 codex web stop adapter-status
```

The installer stages its code and launcher in private durable Router state and
records the original User `CODEX_CLI_PATH` and `CODEX_NODE_REPL_PATH` selections
before changing either. It preserves unrelated hooks.
Review and trust **Stopping ChatGPT Web generation through Router adapter**
in Codex Settings → Hooks, then fully quit and reopen
Codex normally. No external Web launcher or special startup script is needed.
Verify actual Stop and same-chat continuation after restart; configuration and
offline tests alone do not establish live cancellation.

The managed adapter contains an immutable browser-code snapshot and recognizes
only exact Router observation programs. Changes to selection, Send or recovery
can keep the existing adapter when its installed qualifier still accepts the
generated observation code exactly. Verify that equality before deployment.
Changes to observation, shared reply or ownership helpers, or Stop cleanup need
the supported adapter installer from the matching Router source and a full Codex
restart. The managed hook definition remains unchanged. Preserve a compatible
Router source, adapter generation and private configuration for rollback;
rolling back launch selections alone restores the original installation baseline.

```powershell
.\model-router.ps1 codex web stop adapter-rollback
```

Rollback restores only still-owned launch selections and removes only the owned
adapter hook, preserving foreign edits and the staged files. Fully quit and reopen
Codex afterward. A Codex update needs a fresh compatibility check
for the selected official executables and browser runtime.

Tool revocation and next-turn reconciliation alone do not establish immediate
browser cancellation. Stop keeps the saved chat and tab open. Route errors fail
explicitly without a model fallback. Offline tests cover the runtime contracts;
immediate Stop requires live verification with the selected official runtime and
trusted adapter hook. Earlier native-patch trials remain historical evidence.

The integration accepts text input. Media upload is unsupported and rejected.

## Actual model and effort

| Picker identity | Route suffix | Codex effort → browser control |
| --- | --- | --- |
| GPT-6 Sol Instant (Web) | `gpt-6-sol-instant` | `low` → Instant |
| GPT-6 Sol (Web) | `gpt-6-sol` | `medium` → Medium; `high` → High; account-dependent `xhigh` → Extra High |
| GPT-5.6 Sol Instant (Web) | `gpt-5.6-sol-instant` | `low` → Instant |
| GPT-5.6 Sol (Web) | `gpt-5.6-sol` | `medium` → Medium; `high` → High; account-dependent `xhigh` → Extra High |
| GPT-5.6 Sol Pro (Web) | `gpt-5.6-pro` | `max` → Pro |
| GPT-6 Astra Pro (Web) | `gpt-6-pro` | `max` → Pro |

Every slug has prefix `chatgpt-web/`. Pro rows require the saved account capability
to expose Pro. Router verifies the browser family and effort before Send; a shared
internal ChatGPT backend ID does not identify the serving model. Unsupported
effort fails without silently changing models or using Codex inference.

## Subagent selector

```powershell
.\model-router.ps1 codex subagents protocol status
.\model-router.ps1 codex subagents protocol v1
.\model-router.ps1 codex refresh-catalog
```

The default remains V2. V1 enables plaintext collaboration and permits configured
Web roles. V2 retains the certified route contract and excludes Web
roles. Picking a Web primary model never switches the protocol. Changing the
selector requires a full Codex restart and a new conversation; it cannot convert
an existing task.
The CLI reports the configured protocol and this restart requirement, not the
protocol of an already-running conversation. User-owned conflicting feature
settings are refused rather than overwritten.

V1 alone does not establish browser authentication or tool readiness. Native
parents continue to use their ordinary Codex allowance. Existing V2 proof files
do not certify Web routes.

```powershell
.\model-router.ps1 codex web status
.\model-router.ps1 codex picker hide chatgpt-web/gpt-6-pro
.\model-router.ps1 codex subagents protocol v2
.\model-router.ps1 codex web disconnect
.\model-router.ps1 codex refresh-catalog
```

Disconnect disables new Web requests and publication. It preserves saved browser
configuration and the protected tunnel key; remove the key separately when needed.
