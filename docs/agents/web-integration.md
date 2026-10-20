# ChatGPT Web integration maintenance

Use this guide when changing the browser lifecycle, context delivery, native-tool
broker, or Stop adapter. For setup, model selection and everyday use, start with
[ChatGPT Web models](../CHATGPT-WEB.md).

The maintained source owners are `src/chatgpt-web.mjs` for configuration and dispatch,
`src/web-runtime.mjs` for conversation and tool coordination, `src/web-browser.mjs`
for browser programs, and `src/web-stop-adapter*.mjs` for immediate cancellation.

## Saved chats and browser lifecycle

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
concurrently between navigation/ownership checks. Each native browser read returns
control promptly so Interrupt cleanup can run in the official Node REPL child.
With the Router MCP adapter installed, one pending native observation call spans
those short reads. A protected loopback notification wakes it on broker activity;
browser completion, capacity errors and observation failures also return it. The
adapter spaces its internal reads rather than repeatedly emitting visible wait
calls. Its safety deadline renews the outer wait within Codex's call timeout.
Stop prevents further reads and waits for an in-flight read's actual terminal
callback before the existing cleanup. The separate final retention check, broker
revision fences, protected durable writes and Interrupt hook remain.

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

## Native tools and cancellation

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

## Immediate Stop

Immediate browser Stop needs both the interrupted conversation's native context
and enough time to confirm that its exact Stop button disappeared. Ordinary tool
calls receive canonical session/turn metadata and sandbox authority; a stock local
Interrupt hook supplies only the thread ID. A direct browser hook therefore cannot
recover that context by itself. The earlier direct-hook failure is recorded in
the [dated verification evidence](../history/2026-10-17-web-saved-chat-verification.json).

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
[dated Stop and same-chat continuation evidence](../history/2026-10-19-web-stop-adapter-verification.json).
The record covers the all-ordinary configuration after a normal Codex restart,
with the same saved chat, tab and binding retained. Its live check used one
Instant Web primary route; it does not individually certify every Web model.

## Adapter installation and rollback

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

The resident helper version covers only its retained reply, view, observation and
DOM dependencies. Separately shipped selection, Send and recovery programs do not
change that helper version. The managed adapter contains an immutable browser-code
snapshot and recognizes only exact Router observation programs. Changes to selection, Send or recovery
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
