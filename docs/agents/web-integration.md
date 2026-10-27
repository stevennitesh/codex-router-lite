# ChatGPT Web integration maintenance

Use this guide when changing the browser lifecycle, context delivery, native-tool
broker, or Stop adapter. For setup, model selection and everyday use, start with
[ChatGPT Web models](../CHATGPT-WEB.md).

| Change | Read next | Source owner |
| --- | --- | --- |
| Instruction delivery or native compaction | [Context delivery](#instruction-delivery-and-compaction) | `src/web-runtime.mjs` |
| Closed tabs, restarts or uncertain delivery | [Ownership and recovery](#ownership-and-recovery) | `src/web-runtime.mjs`, `src/web-browser.mjs` |
| Reply observation or completion | [Observation and completion](#observation-and-completion) | `src/web-browser.mjs`, `src/web-stop-adapter.mjs` |
| Full ChatGPT conversation | [Successor handoff](#full-conversation-handoff) | `src/web-runtime.mjs` |
| Native tools or connector failures | [Tools and cancellation](#native-tools-and-cancellation) | `src/web-tools.mjs`, `src/web-mcp.mjs`, `src/web-tunnel.mjs` |
| Immediate Stop | [Stop authority and completion](#immediate-stop) | `src/web-browser-state.mjs`, `src/web-stop-hook.mjs`, `src/web-stop-adapter.mjs` |
| Browser compatibility tests | [Independent verification](#independent-verification) | `scripts/test-web-stop-browser.mjs`, `test/fixtures/web-stop-browser.html` |
| Adapter update or rollback | [Installation and rollback](#adapter-installation-and-rollback) | `src/web-stop-adapter-install.mjs` |

`src/chatgpt-web.mjs` owns configuration and route dispatch. `src/web-models.mjs`
owns model identity and effort mapping; the user guide lists their public controls.
Disconnect validates and preserves supported saved configuration even when an
old browser module or tunnel executable is gone. Disabled settings remain readable
for status and catalog refresh; malformed or unreadable settings still fail.
Enabled use and fresh configuration require regular runtime files. Disconnect
disables future admission; it does not cancel an admitted turn, stop services,
remove the adapter or delete the protected key. Refresh the catalog to remove
published Web models and V1 roles. Configuration and catalog publication share
the existing cooperative lock; direct edits outside that lock are not fenced.

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

A failed private checkpoint fails the owning native turn. A later new turn must
successfully save the latest in-memory checkpoint before browser work resumes;
replaying the failed turn does not retry it. Continued storage failure remains
an error, and uncertain Send or native-action records retain their guards.

### Instruction delivery and compaction

The full bridge protocol and exact current Codex instructions are sent on first
attachment or an instruction revision. A unique local prompt-owned DOM turn
anchors observation and immediate Stop. It does not prove that ChatGPT accepted
the input: optimistic turns can be followed by a site rejection and restored
draft. Router starts ordinary observation immediately after this anchor, without
waiting inside Send for a native tool that observation must deliver.
Send and Stop use the same bounded selector-wait helper. A capped SDK wait can
rearm only within the original caller deadline, after a coherent state read.
Send readiness includes the unique latest prompt marker and valid new turn
identity; its final page proof remains authoritative. Failed confirmation keeps
Send uncertain and reports a fixed failure stage, never another Send click.
Paste readiness, picker verification, Send dispatch and its confirmation share
the original Send deadline. Picker stages recheck its remaining allowance before
another action; Send reserves its final ownership proof before dispatch. Interrupted
continuation likewise gives Stop only its remaining confirmation allowance and
keeps a final read reserve. Expired pre-dispatch work cannot click Send or Stop;
an attempted action keeps its existing uncertainty and no-replay rules.

Current-generation substantive assistant output or an authenticated current-token
broker handler acknowledges input. Registration, declaration updates, Stop visibility
and complete turn state do not. Until that proof, the active turn keeps its URL,
reply baseline, generation and proposed checkpoint privately; the durable prior
checkpoint, instruction digest and compaction aliases remain unchanged, with Send
uncertain. Failure, cancellation or restart does not replay that uncertain input.
Acceptance records the instruction digest and
the owning browser generation in optional V1 ledger fields
`deliveredInstructionsSha256` and `deliveredInstructionsGenerationTurnKey`.
Unchanged follow-ups carry a fresh turn-token directive and the exact new
transcript items, without repeating protocol reminders. A missing or stale
delivery record requires full instructions;
changed instructions explicitly supersede the earlier instructions. A successor
chat receives full instructions. Existing rollback readers can still read these
records and resume with their ordinary full instruction delivery.
After paste settlement, Send appends the current tool-token directive beside the
generation marker in the visible composer. This keeps the current authority out
of an automatically created text attachment without discarding its context. The
structured token comes from the current broker registration, never from parsing
historical transcript text; exact draft checks cover both visible additions.
Checkpoint matching and construction reuse the same request-local item digests;
the complete request fingerprint and changed-result checks remain independent.

Web-route native compaction selects source excerpts locally, without requesting
a model summary. Both standalone compaction and native V2 compaction stay local;
they do not generate a Web reply or request browser tools. This is separate from
the [subagent protocol selector](../CHATGPT-WEB.md#subagent-selector). For an owned
saved conversation, Router records the delivery boundary and preserves genuinely
undelivered native items.
V2 carries those exact items inside the readable checkpoint because Codex keeps
only the compaction output item. New material is never silently excerpted to fit
that carrier: compaction fails if it cannot fit. Continuing sends the new items
without repeating a summary of history already delivered to ChatGPT. A first
attachment with readable compacted history still uses that checkpoint to seed
its new chat.

### Ownership and recovery

After a failed first initialization, a restored record may bootstrap again only
when it has no established tab, saved URL, checkpoint, generation or delivery
evidence, its last turn is definitely unsent, and it has no uncertain input or
unresolved native action. Bootstrap reuses the same binding identity. If a partial
binding still owns a tab, ordinary open refuses it rather than creating another
tab or changing its draft. This does not replace an established saved conversation.

Native REPL handles are a cache: Interrupt or restart can remove them while the
original tab survives. Continuation can restore the binding on that exact tab
at its recorded saved URL without opening or navigating a tab. If the original
tab is absent, recovery may reacquire one unique saved-URL match or reopen the
recorded chat in that Codex conversation's browser. Every path requires the
confirmed generation checkpoint and matching saved-chat proof, including the
previous reply's identity and text prefix. If Stop preceded a readable answer,
the confirmed generation's unique latest turn can establish ownership instead.
Successful recovery retains `recovered:true` and reports `bindingRestored:true`.
Only the original surviving tab without recovery navigation reports both
`tabReopened:false` and `tabNavigated:false`. A new tab or changed tab identity
reports `tabReopened:true`; recovery navigation or reload reports
`tabNavigated:true`.
An existing tab restored to the known immediate predecessor of a completed
checkpoint may be stale. Recovery may reload that exact saved URL once, only
after checking that all mounted replies belong to the saved baseline, its last
reply is the final baseline reply, the idle composer control is uniquely visible,
Stop is not visible, and the composer is empty.
The reload must reveal the exact checkpoint and pass the full recovery proof;
it does not authorize replay, a replacement chat, or ignoring a changed reply.
Tab IDs alone do not identify a chat. Reopening preserves the saved conversation;
it does not resend its full history or execute historical tool calls again. An
uncertain Send or unresolved native coding action blocks continuation until its
actual outcome is known. A deleted or inaccessible chat, a changed nonempty tab,
a user draft, missing ownership, unreadable history or inconsistent reply
evidence fails explicitly rather than silently starting a replacement chat.

### Observation and completion

Each confirmed Send owns one rendered logical turn. That turn can contain
commentary, tool activity and several assistant messages. Router reads the latest
answer within that turn; it does not bind the whole generation to its first
assistant message. Older turns and embedded tool widgets cannot establish a new
answer. Before input acceptance, a held observation may see the original turn
temporarily unmount or return behind an unsettled placeholder or pre-Send turn.
Each short read then returns only a private content-free ownership-pending frame
to the adapter, which continues within its original deadline. This applies after
an earlier owned empty read too. The frame never reaches the tool broker and
cannot acknowledge input or adopt a reply. Only the original unique latest key
can resume observation; older turns remounting before it cannot displace that
proof. The binding retains already verified historical turn keys across ordinary
continuation, so a known history-only remount may also remain pending. A duplicate
original key or an unowned new foreign UUID fails immediately. Post-acceptance
ownership loss and ambiguous message identities still fail explicitly.
Terminal ownership diagnostics report current turn counts and whether the latest
identity matched, without text or identities.

Bootstrap installs separately versioned observer and mutation helpers in the
native Node REPL binding. Observation, retention, ordinary continuation and Send
invoke them with compact operation requests and selector overrides. Source
digests, frozen controllers and exact state bindings are checked before use.
Picker and Send dependencies do not change the observer digest. If a continuation
finds a missing or stale helper, it returns a fixed no-action receipt before
accessing the page. Only that receipt permits one full continuation installation
and the existing recovery checks. A second receipt, a changed receipt or a missing
Send helper fails explicitly; Send is never retried. These helpers run in the
native REPL, not injected page code. Open and rollover retain their direct
lifecycle programs, and all mutations retain their existing ownership, draft,
generation and uncertain-action checks.

Each reply snapshot retains mounted turn/message identities and order, while
reconstructing answer text and completion details only for the owned generation.
Send baselines read identities without historical answer bodies. New-turn
anchoring reads the candidate marker, then independently verifies global
uniqueness and latest-turn ownership. Ordinary continuation reads the owned
generation; recovery still reads the historical proof it needs. A bounded locator
wait establishes anchor readiness without repeatedly scanning full history.
Readiness alone does not acknowledge input or establish ownership.
Mutation checks share a coherent semantic read within each phase; checks before
and after model selection or handoff remain separate fresh observations.
Public SDK exact-name locators own accessible-name resolution, including text,
direct labels and `aria-labelledby`. SDK-guarded BODY profiles prove Stop state,
mounted control cardinality and absence of temporary-chat controls in the same
read as the owned turn, Regenerate nodes and current URL. Only semantic Regenerate
nodes outside answer, user, reasoning, tool and code content can establish their
position after the answer; quoted controls cannot supply or duplicate that proof.
The last observed Stop state only orders profile probes. Ordinary active reads
and steady inactive reads use one projection; a state transition can require a
second profile. Exact site error or capacity text uses separate uncommon indicator
projections rather than adding per-control RPCs to every read. These projections
use normal-mode and cardinality guards independent of Stop state, then refresh the
current Stop and answer frame before returning. Indicator evidence cannot survive
loss of the unique latest generation. Every profile and indicator read spends the
same short-read allowance, including owned-tab preflight; late positive proof is
rejected. This allowance derives from the adapter's native finish headroom after
its transport margin, with no new allowance for a second profile. These projections
retain independent ownership and navigation checks. Each native browser read returns
control promptly so Interrupt cleanup can run in the official Node REPL child.
With the Router MCP adapter installed, one pending native observation call spans
those short reads. While input acceptance is pending, the first substantive
current-generation text returns through the existing native callback even if the
answer is unfinished. Router verifies and persists acceptance before issuing the
next wait; later partial text does not add callbacks. A Stop receipt alone never
acknowledges input, and cancellation before that proof is persisted remains uncertain.
A protected loopback notification wakes the wait on first input acceptance,
native tool transitions, catalog/policy changes or turn retirement. Subsequent
read-only discovery and unchanged declaration updates do not force another native
browser round trip. All activity still advances the independent completion fence;
quiet completion must pass a fresh read after activity settles. Ordinary broker
observers retain their complete revision stream. Browser completion, capacity
errors and observation failures also end the wait. The
notification uses an owned Node HTTP request with its abort signal and no shared
connection pool. This private loopback channel accepts the configured listener
port without browser Fetch port restrictions; failed or malformed broker
responses still fail closed. The adapter spaces its internal reads rather than
repeatedly emitting visible wait calls. The renewal deadline stops scheduling new
reads; an already dispatched read keeps a separate execution allowance within
Codex's call timeout. Shrinking that read's execution budget to the remaining
renewal interval can time out a normal read and reset the native REPL kernel.
Renewal waits for its actual result.
Stop prevents further reads and waits for an in-flight read's actual terminal
callback before the existing cleanup. The separate final retention check, broker
revision fences, protected durable writes and Interrupt hook remain.
V1 Web subagents use the same held observation wait without acquiring primary
Stop authority. Cancellation forwards to the active native child and retains its
mapping until the actual terminal callback; an undrained orphan blocks admission.

Native tool requests are delivered independently of final-answer readability.
Completion requires an idle owned browser turn, an answer after the latest tool
boundary, and unchanged broker activity across the completion read and final
delivery. A completed page with unreadable output or no post-tool answer ends
with a bounded error instead of waiting for the general generation deadline.
An exact visible site **Unknown error** and **Retry** pair rejects the request only
when it belongs to the unique latest owned generation (inside its turn or an
adjacent control region before the composer), outside user, assistant, reasoning,
tool and code content, and the exact submitted composer with its current generation
marker has been restored. The submitted text is the actual settled composer after
paste attachment conversion. A restored draft alone is ambiguous. The browser
returns only a fixed `requestError` category; the adapter ends its held observation
immediately and Router reports `web_request_failed` before draining queued native
calls. Retry and draft clearing are never requested. Actual prior broker acceptance
and native results remain acknowledged after a later site failure.

### Full conversation handoff

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
A first input rejected by that explicit capacity signal can retain a separate
optional V1 `capacityChatUrl` without inventing a delivered checkpoint. It is a
strict saved URL used only for the already authorized successor flow and restart
reconciliation, and is cleared when successor input is accepted. The accepted
chat URL, generation and instructions retain their earlier meaning. A lost browser
binding still cannot reconstruct an unproved rollover or overwrite a draft.

## Native tools and cancellation

The connector discovers only tools declared and allowed for the current native
Codex request. Its `codex_tools_list` operation accepts `names` for exact wire or
`namespace.name` identities, or a case-insensitive `query` matching current names,
namespaces and descriptions. An exact query match excludes fuzzy matches;
otherwise prefixes, name substrings and descriptions determine the order. Results
contain `tools`, `total` and, when needed, `nextCursor`. Pages default to eight
definitions, with `limit` bounded from one to 32. Omit both selections to page
through the catalog. Cursors belong to the active token, selection and accepted
catalog/policy generation; ordinary activity and unchanged declarations do not
invalidate them. Restart discovery after a catalog or allowed-tool change.
Each selected tool retains its complete schema or custom grammar; discovery does
not grant authorization. Prefer exact identities or a focused query.
Reuse a discovered definition within the active Codex turn while declarations
remain unchanged. Inspect one response representation instead of printing both
text and structured content or unrelated registry entries. Router-created JSON
results use one text representation; original MCP envelopes retain their content,
structured data, errors and metadata. Independent reads can use an existing
discovered tool's batch facility; native approval, result and cancellation checks
remain in force.
Web registration shares collision-safe wire naming with the provider relay while
retaining original native schemas and grammars. It does not run provider schema
translation to derive those identities.
It requests a tool by its exact identity, and Router returns that
request to native Codex for execution and approval. Router itself does not run
shell commands or bypass Codex approvals. Tool results return to the same active
browser turn before ChatGPT continues. Private turn tokens and the tunnel runtime
key are transport state and must not appear in answers or logs.
An unchanged declaration set reuses its private accepted registry. Each update
still evaluates current tool choice and advances its broker revision; changed
schemas rebuild the registry without reassigning reserved wire identities.

The loopback MCP listener retains at most 32 SDK sessions. Admission reclaims
expired sessions immediately and, under pressure, the least recently used fully
inactive session. An HTTP upload or response, accepted handler, unresolved native
result or live broker-turn association prevents reclamation. The periodic reaper
uses the same rule. Session expiry returns HTTP 404 before accepting an action;
the client must initialize a new session. Router does not retry a native action
to repair a connection. Closing a client connection alone does not necessarily
terminate its server-side session. Local capacity errors record only fixed
categories and aggregate counts, so an external connector rate limit remains a
separate diagnosis.

Changing the gateway input schema also requires [refreshing the existing ChatGPT
connector's metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)
after deployment. Router's catalog and adapter refreshes do
not update that hosted metadata. In the connector settings, use Refresh and verify
that `names`, `limit` and `cursor` are advertised before qualifying these arguments
in a disposable conversation and an existing saved-chat continuation. Keep the
saved-chat mapping and working rollback intact throughout activation.

Native cancellation retires the exact Web turn and revokes further connector tool
access; cancelled or timed-out tool calls are not replayed. Router preserves the
session's tab identity and marks the verified tab for retention before generation.
The next turn reconciles the interrupted generation, stops it if necessary,
captures its partial reply and continues in that same chat. Stale cleanup cannot
stop a newer turn. Revocation does not undo
a tool that native Codex has already started. A missing or changed native rollout
prevents the runtime from asserting cancellation authority.

Terminal turns release unused prompts, declarations and browser-answer copies
only after their request, cancellation watcher and ordered state writes settle.
Intermediate and final replay records retain the exact serialized reply body and
metadata once, with at most eight intermediate records. Each caller gets an
independent response body and headers. Replays do not regenerate IDs or events,
repeat native actions, or bypass changed-result checks; final retirement releases
the intermediate records.
Web responses already contain complete outputs. Their SSE framing sends complete
function/custom inputs in item and terminal events, without synthetic argument
deltas or repeated field-done bodies. Message text retains its progress event;
item and terminal events retain full content. Native identities, raw inputs,
namespaces, tool-search framing, sequential event numbers and unknown usage keep
their existing meaning. JSON replies use the same validated output items.
Cancelled IDs retain rejection records, and completed requests retain their exact
final response for fingerprint-matched replay. Conversation checkpoints,
compaction and uncertain-action evidence remain available for recovery.

Normal `web-mcp` logging reports errors without success-progress receipts.
HTTP capacity rejections emit `admission-rejected` receipts before tool dispatch,
with a fixed `session-capacity` or `observation-capacity` reason, HTTP status and
aggregate session, creation, pending-call and observation counts. They contain
no request bodies, session identities or private tokens. Correlate these receipts
with a connector's reported HTTP error before attributing a 429 to Router;
an upstream error envelope alone does not identify which capacity was reached.
For an on-demand diagnostic run, set `CODEX_ROUTER_WEB_MCP_TRACE=1` in Router's
launch environment before starting it. Full trace distinguishes SDK handler
arrival, wrapper rejection, discovery, invocation start and the actual paired
result. Receipts contain fixed categories, timestamps and a turn-token digest,
without tool arguments, outputs or credentials. Arrival occurs after
HTTP/session/protocol validation; its absence alone does not identify a ChatGPT
safety decision. Invocation start does not prove native execution was accepted.
The fixed `turn-not-active` diagnostic means the supplied token was rejected
before admission; no invocation from that request was accepted. It does not
disclose another turn's token or authorize replay. Failures after admission keep
their generic uncertainty response, even if they carry the same internal code.

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
Interrupt hook calls the adapter's own callback with a ten-second timeout.
The shared contract reserves transport headroom within that deadline and waits
on the same inactivity predicate after one Stop click. Fast transitions return
immediately; the longer failure bound allows Pro's controls to settle after
cancellation. Elapsed time never supplies confirmation.
Only that matching trusted callback authorizes Stop. Bundled one-second callbacks
keep their original messages and cancellation scope; their arrival or forwarding
does not expire the originating authority before the trusted callback arrives.
Cleanup waits for actual terminal responses from any already forwarded bundled
callbacks and active browser call before admitting another native operation.
All of this work shares the trusted callback's existing deadline. A timeout,
cancellation of cleanup itself, or changed authority prevents admitting further
cleanup actions. Sending cancellation does not prove an in-flight operation ended.

A verified native Send result arms cleanup before the first observation. Its
exact saved URL, tab and generation key can prove the cancellation target while
Router has yet to consume that result. This does not rewrite the delivery ledger
or clear an uncertain Send for context replay. An unconfirmed Send never supplies
cleanup authority and is never repeated.

Stop verifies that the exact owned generation is unique and latest, marks its
saved tab for handoff, then attempts the semantic Stop click at most once. Its
locator includes that generation condition when the browser resolves the action.
`src/web-browser-state.mjs` owns the page controls and the shared Stop predicates.
Interrupted continuation uses those same predicates and rechecks the generation
in its final snapshot before transferring browser ownership. Its in-binding
receipt is shared by native Interrupt cleanup and interrupted continuation.
Cleanup records the generation-bound dispatch before awaiting the click and
retains acknowledgement only after SDK success and an ownership recheck. This
preserves the witnessed composer transition for continuation even when the page
still marks the turn incomplete, and prevents a rejected or uncertain click from
being repeated. A fresh cleanup controller does not manufacture an ordinary
browser binding or take a diagnostic event receipt as authority. Before Send,
continuation requires an idle composer and has no authority to stop an unknown
generation. Ordinary continuation omits this recovery-only program source.
Readiness and confirmation use the same conditional semantic locator. Accessible
names, visibility and cardinality come from the public browser SDK; Router does
not classify those matches again from raw `aria-label` values. A hidden mounted
Stop control does not block the idle predicate. Duplicate semantic controls still
prevent confirmation. Each accepted conditional body is read with its URL and
generation state in one synchronous DOM projection. An unconditional body read
can supply failure diagnostics, never inactivity proof.
URL, generation state and Stop visibility come from one synchronous DOM read,
so a later URL request cannot make a stale snapshot appear current. A
hidden or temporarily missing button alone does not prove inactivity. Success
requires hidden Stop plus either the same generation's explicit complete state,
or an observed composer transition after an acknowledged click: the exact
**Start Voice** control was absent immediately before the click and is uniquely
visible afterward. The second path proves that ChatGPT returned its composer to
idle; it does not assert a completed answer or remote transport closure. A click
error or a no-click observation still requires the explicit complete state.
Readiness uses a shared conditional locator wait followed by a coherent ownership
and state read. If the public SDK caps that wait before the original deadline,
or its condition changes before the read, Router can rearm the same condition
within the remaining budget. Only recognized original SDK timeout reasons permit
rearming after a rejected wait; other errors receive one decisive state read.
Rearming adds no sleeps or Stop clicks. The wait itself never grants success.
If the click rejects after settling, cleanup can still read the complete state;
an observed inactive generation is reported with its action error preserved,
rather than pretending the click acknowledged or repeating it. Retention acknowledgement
and actual tab survival are separate evidence; live checks confirm survival.

Browser work and readback use the remaining native execution budget.
Read admission reserves time for follow-up work; accepting a completed read uses
the actual deadline and rechecks authority, without charging that reserve again.
Some public SDK operations have no per-call timeout, and failed clicks can perform
additional SDK diagnostics before rejecting. A request that does not settle within the host
deadline remains unconfirmed; cleanup does not race it with another UI action.
The public browser API cannot make the generation predicate atomic with native
pointer dispatch; a concurrent manual replacement during that final input boundary
remains a platform limitation rather than a guarantee supplied by Router.

The native execution allowance and terminal receipt deadline are separate. The
adapter waits for the terminal result through the remaining original callback
budget, including after the native execution allowance expires; it does not give
the browser more execution time. No terminal reply by that deadline is an
acknowledgement timeout, rather than an observed native error.

An internal request remains owned until its actual terminal reply or child closure,
even after local retirement. Late replies are consumed and recorded as historical
evidence; they cannot produce a second hook response or renew cancellation authority.
Another adapter cleanup cannot start while an earlier one is actually unsettled.

An unconfirmed native cleanup records whether the child returned an RPC error,
a tool error, an invalid result, or no response. Diagnostics retain only numeric
RPC codes, fixed runtime failure signatures, known JavaScript error classes/kinds and
bounded text size/digest; arbitrary error text and private payloads are omitted.
These observations locate a failed boundary and do not establish that Stop ran.
Stop readback also records a fixed state category and bounded counts for Stop,
idle, unrecognized and `aria-labelledby` controls, plus nullable visibility,
recognition and completion flags. A new read clears the previous values; missing
or rejected observations remain unknown. Predicate-backed reads leave counts
they do not observe as null; they do not infer counts from label attributes.
`invalid_controls` distinguishes rejected
control markup from `unconfirmed_readback`, where the accepted view supplies no
inactivity proof. These diagnostics retain no control labels or page content and
do not relax Stop confirmation.

The unmodified official CLI adapter path has
[dated Stop and same-chat continuation evidence](../history/2026-10-19-web-stop-adapter-verification.json).
The record covers the all-ordinary configuration after a normal Codex restart,
with the same saved chat, tab and binding retained. Its live check used one
Instant Web primary route; it does not individually certify every Web model.

## Independent verification

Keep the following checks separate so a failure identifies its own boundary:

1. **Policy and transport:** run the affected Node tests for ownership, one-click
   behavior, authority changes and callback deadlines. These controlled fixtures
   do not establish browser SDK or current ChatGPT markup compatibility.
2. **Rendered browser contract:** run the installed SDK against the isolated
   fixture below. This checks real role matching, XPath, visibility and locator
   waits without ChatGPT, a connector, saved history or a human Stop press.
3. **Recovery:** after a restart or recovery change, send one short recall request
   in the approved saved Web chat. Require completed native delivery, the prior
   marker recalled without supplying it, the same saved URL and no uncertain Send
   or unresolved action. A failure before Send is a recovery failure; no Stop
   trial has occurred. Do not start a long response until this passes.
4. **Live Stop:** start generation in that established chat, press Codex Stop once,
   and correlate the interrupted native turn with its exact adapter receipt and
   observed tab retention. Acknowledged click, confirmed inactivity and tab
   survival are distinct facts. Report an unavailable confirmation as unknown.
5. **Continuation:** send a separate short recall request after Stop and require
   completed delivery in the same saved URL, tab and native binding identity.
   Missing REPL handles may use the [same-tab binding restoration](#ownership-and-recovery)
   above. Do not resume the interrupted work or supply the marker in the request.

Run native-tool verification separately when the tool path changes. A recovery
check does not need a native command, and a browser-contract fixture does not
need a tool connector. Reuse passing checks while their relevant inputs remain
unchanged; documentation edits do not require another manual Stop trial.

### Automatic agent-run verification

Use the maintained helper for live checks in an explicitly approved disposable
Codex Web chat. The agent drives the existing app tools and native UI; no human
Stop press, extra inference controller, runtime patch or special app launch is
needed. This is an on-demand Desktop check, not a headless CI command or a check
to add to ordinary conversation turns.

```powershell
npm run verify:web -- prepare --thread <approved-chat-id> --output generated/NEW
npm run verify:web -- prompt --run generated/NEW/run.json --phase native
npm run verify:web -- wait --run generated/NEW/run.json --phase native --turn <native-turn-id>
```

For model qualification, prepare with `--model <exact-web-slug> --effort <level>`.
Supply both together. Each phase then requires the native turn's exact model and
effort and the matching browser family and Power in its successful Send. Use that
same model and effort when sending every phase; a passing Instant run does not
qualify a Thinking or Pro route. Receipts retain only registry-known identities
and bounded selection values. The helper accepts the app's leading model-switch
instruction envelopes without treating them as tool results.

Preparation creates a fresh synthetic file and marker. Send the generated prompt
to the approved chat with the native app tool, then pass its exact turn identity
to `wait`. Repeat `prompt` and `wait` for `recall`, then `ready`. The latter uses
read-only connector discovery before a long response, so acceptance can be proved
even when ChatGPT does not expose readable answer text until completion.

When `ready` passes, use supported computer use to inspect the selected Codex
chat and click its native **Stop** control once. Prefer an unambiguous current
accessibility control; otherwise use a fresh screenshot of the exact chat and
its visible Stop control. Keep accessibility output limited to the needed native
control; do not print an embedded ChatGPT transcript or its turn tokens. Never
retain screen coordinates or element indices
between runs. Clicking ChatGPT's Stop control or invoking the cleanup hook
directly does not exercise native cancellation and cannot replace this step.

Run `wait --phase stop` with that same native turn identity. Only after its
interrupted-turn event and matching positive adapter receipt pass, send the
`continuation` prompt and wait for its exact new turn. Require the original saved
chat, tab and native binding identity, the marker recalled without supplying it,
and no uncertain Send or unresolved native action. Verified same-tab binding
restoration is allowed only with `bindingRestored:true`, `tabReopened:false` and
`tabNavigated:false`; reopening or recovery navigation fails this check. The
helper writes bounded allowlisted receipts and waits on file changes; elapsed
timeouts only bound failures. It does not replay a failed action or change keys,
hook trust, runtime selection, protected ledgers or rollback copies.

If sign-in, tool approval, an account safety block or ambiguous native UI prevents
the next step, report that phase as blocked or failed. Do not substitute a direct
browser cleanup or mark the check passed. Reuse completed offline and rendered
browser checks while their relevant inputs remain unchanged.

Start the fixed loopback fixture server in a normal Windows user terminal:

```powershell
node scripts/test-web-stop-browser.mjs --serve
```

It prints `fixtureUrl` and serves only the test HTML. In the current official
browser REPL, import `scripts/test-web-stop-browser.mjs` by its absolute file URL,
create a disposable blank tab with the documented SDK, and call
`runWebStopBrowserContract({ tab, fixtureUrl })` and
`runWebObservationBrowserContract({ tab, fixtureUrl })`. Require every returned row's
`passed` value to be true. The harness refuses an existing non-fixture tab before
navigation. Close that tab and stop the fixture server afterward.

The cases cover hidden mounted Stop, accessible names from `aria-labelledby`,
name normalization, ambiguous Stop/idle controls, a replacement generation,
the acknowledged Stop-to-idle transition, missing positive inactivity evidence,
and explicit completion. Observation cases exercise the same SDK-backed profiles
used in production, including labelledby Regenerate controls, temporary-mode
rejection and quoted-content exclusion. Fixture transitions use actual button clicks, not
sleep-driven state changes; timeouts are failure bounds. These checks expose SDK
and markup assumptions, while the live check establishes the current ChatGPT
path. Neither guarantees compatibility with arbitrary future updates.

## Adapter installation and rollback

To install the adapter, first collect a local manifest from the current configured
official runtime. Its version-1 shape is below; angle-bracket values describe
fresh observations, not values to copy into an installation:

```json
{
  "version": 1,
  "node": {
    "path": "C:\\<current-runtime>\\node.exe",
    "sha256": "<fresh 64-hex SHA-256>",
    "authenticode": {
      "status": "Valid",
      "signerSubject": "<observed OpenAI OpCo, LLC signer subject>",
      "signerThumbprint": "<observed exact signer thumbprint>"
    }
  },
  "officialCli": {
    "path": "C:\\<current-runtime>\\codex.exe",
    "sha256": "<fresh 64-hex SHA-256>",
    "authenticode": {
      "status": "Valid",
      "signerSubject": "<observed OpenAI OpCo, LLC signer subject>",
      "signerThumbprint": "<observed exact signer thumbprint>"
    }
  },
  "officialNodeRepl": {
    "path": "C:\\<current-runtime>\\node_repl.exe",
    "sha256": "<fresh 64-hex SHA-256>",
    "authenticode": {
      "status": "Valid",
      "signerSubject": "<observed OpenAI OpCo, LLC signer subject>",
      "signerThumbprint": "<observed exact signer thumbprint>"
    }
  },
  "runtimeModule": "C:\\<configured-browser>\\scripts\\browser-client.mjs",
  "sdkPackageJson": "C:\\<matching-router-source>\\node_modules\\@modelcontextprotocol\\sdk\\package.json",
  "threadIds": null
}
```

Run this PowerShell recipe from the matching Router source root, with its
dependencies installed. One Node invocation discovers the configured anchors,
asks the existing read-only signature helper for their actual signatures, hashes
their current bytes, and confirms that discovery is still current before saving
`adapter-build-manifest.json` as BOM-free UTF-8. Collection writes only that local
manifest; it does not install an adapter or change settings, hooks, environment,
services or trust. Choose an unused output filename if keeping an earlier manifest.

```powershell
@'
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverWebRuntimeAnchors } from "./src/web-runtime-refresh.mjs";

const discovery = discoverWebRuntimeAnchors({ sourceRoot: process.cwd() });
const { anchors } = discovery;
const fields = ["node", "officialCli", "officialNodeRepl"];
const paths = fields.map(field => anchors[field]);
const inspection = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
  "-File", path.resolve("src/web-stop-adapter-env.ps1")], {
  input: JSON.stringify({ action: "signatures", paths }), encoding: "utf8",
  timeout: 20000, maxBuffer: 128 * 1024, windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath")),
});
if (inspection.error || inspection.status !== 0) throw new Error("Official signature inspection failed.");
let signatures;
try { signatures = JSON.parse(inspection.stdout); }
catch { throw new Error("Official signature inspection returned invalid JSON."); }
if (!Array.isArray(signatures) || signatures.length !== paths.length) throw new Error("Incomplete signature inspection.");
const manifest = { version: 1 };
for (const field of fields) {
  const matches = signatures.filter(item => item?.path === anchors[field]);
  const observed = matches[0];
  if (matches.length !== 1 || observed.status !== "Valid"
      || typeof observed.signerSubject !== "string" || !/OpenAI OpCo, LLC/u.test(observed.signerSubject)
      || typeof observed.signerThumbprint !== "string" || !observed.signerThumbprint) {
    throw new Error(`Expected one valid OpenAI signature for ${field}.`);
  }
  manifest[field] = { path: anchors[field],
    sha256: createHash("sha256").update(readFileSync(anchors[field])).digest("hex"),
    authenticode: { status: observed.status, signerSubject: observed.signerSubject,
      signerThumbprint: observed.signerThumbprint } };
}
manifest.runtimeModule = anchors.runtimeModule;
manifest.sdkPackageJson = anchors.sdkPackageJson;
manifest.threadIds = null;
discovery.assertCurrent();
writeFileSync("adapter-build-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Manifest collection failed; do not install a partial or older candidate.' }
```

Missing or conflicting configured anchors must stop collection. Repair the
configuration deliberately or prepare a reviewed explicit manifest; do not select
a cache directory by age, reuse historical hashes or thumbprints, or bypass trust
checks. Review the resulting paths, observed signers and intended thread scope.
`threadIds: null` enables ordinary Web conversations; for a restricted trial,
replace it with a nonempty array of exact existing Codex thread UUIDs. The adapter
excludes subagent metadata. Credentials and tunnel keys do not belong in this file.

Collection is an observation, not approval or activation. The existing installer
is the authoritative full path, byte, signature, SDK and scope validator. Invoke
the separate installation stage only after that review:

```powershell
.\model-router.ps1 codex web stop install-adapter .\adapter-build-manifest.json
```

The installer returns its activation result. Use `web status` for optional
combined diagnostics; a second `adapter-status` call is unnecessary.

The installer stages its code and launcher in private durable Router state. It
preserves the original User `CODEX_CLI_PATH` selection, including an unset value,
and overrides only `CODEX_NODE_REPL_PATH`. The inspected CLI identity records
compatibility; the adapter does not pin the whole app to that CLI build. Updating
an older owned installation releases its CLI pin back to the original selection.
Foreign changes are preserved, and unrelated hooks are untouched.
If the saved browser runtime or tunnel configuration changed, also use the
[guarded Router restart](../INSTALL.md#replacement-and-drain) to reload that
configuration before live verification. A Codex restart only reloads the adapter;
it does not restart Router's already initialized Web services.
Review and trust **Stopping ChatGPT Web generation through Router adapter**
in Codex Settings → Hooks, then fully quit and reopen
Codex normally. No external Web launcher or special startup script is needed.
Verify actual Stop and same-chat continuation after restart; configuration and
offline tests alone do not establish live cancellation.

The resident helper version covers only its retained reply, view, observation and
DOM dependencies. Picker-only labels and controls are separated from both the
resident configuration and its version inputs. Separately shipped selection,
Send and recovery programs do not change that helper version. The resident
controller captures frozen default selectors once. Compact observation
and retention programs carry only differing selectors; each call merges them
without changing those defaults. Program decoding expands the effective selectors
only after exact source qualification, preserving Stop checks and custom overrides.
The managed adapter contains an immutable browser-code snapshot and recognizes exact Router Send and
observation programs. Send qualification acquires pending cleanup authority before
the first observation. Changes to selection, Send or recovery can keep the existing
adapter only when its installed qualifier still accepts the generated Send,
observation and retention programs. Check those programs before deployment; an
unchanged resident helper version alone does not establish adapter compatibility.
Changes to the adapter's waiting behavior also require its matching rebuild and
restart, even when an older qualifier accepts the new observation options.
Changes to observation, shared reply or ownership helpers, or Stop cleanup need
the supported adapter installer from the matching Router source and a full Codex
restart. An unchanged managed hook retains its trust. The exact owned older
three-second hook is updated to the current ten-second definition; review and
trust that changed definition in Codex before verifying Stop. Preserve a compatible
Router source, adapter generation and private configuration for rollback;
rolling back launch selections alone restores the original installation baseline.

After an app update removes old runtime files, use a fresh manifest for the current
signed CLI, Node, Node REPL and public browser module. Replacement verifies the
retained adapter's own protected files without requiring the deleted old app
files; the new candidate still needs complete signature and hash verification.
Refresh the saved Web configuration too if its browser module path changed.
Runtime anchors are rebound deliberately before restart, never during an active
browser call.

`model-router.ps1 codex web refresh-runtime` plans that refresh from the configured
Node REPL command, its paired Node executable, and the configured trusted browser
service. It uses the existing CLI identity resolver and the installer's candidate
validation. Missing or conflicting configured anchors require an explicit
`--manifest`; cache-directory age does not establish runtime authority.
Refresh requires enabled saved Web settings and an existing owned adapter receipt.
Maintenance status separates structurally valid saved settings, retained adapter
ownership and external runtime availability. It validates the current candidate
once through the refresh planner rather than first checking the obsolete cohort.
An absent old runtime does not become an ownership conflict; invalid signatures,
changed protected artifacts and foreign launch selections remain separate failures.
Its `--manifest` input cannot bootstrap the first installation or provide a
standalone first-install validation mode; use the collection and installation
stages above for initial setup.
`--apply` coordinates adapter replacement, saved browser configuration and the
existing guarded service restart. It preserves connector/tunnel identities,
capabilities and runtime-key storage. It preserves an unchanged hook definition;
`hookDefinitionChanged` identifies the owned hook update requiring renewed trust.
The current generation
remains fixed during admitted calls, and failed refreshes preserve or restore
still-owned prior state. A reported Codex restart is needed to load the new adapter.
Normal online refresh requires explicit known-idle Web counters from the serving
Router, including the gaps between native HTTP requests. Forced maintenance can
retain uncertain Sends when the authenticated closed drain reports zero active
requests, known zero active turns and unresolved actions, and finite nonnegative
uncertainty. It additionally requires a fresh complete Windows process census
showing no full Codex/ChatGPT host, managed adapter, or official process beneath
either runtime's CLI/Node/browser roots, including code-mode hosts and descendant
tool processes. The old cohort comes from the retained protected
adapter manifest, even when its external app files were removed; the validated
new candidate owns the current anchors. Generic Router Node processes are not
browser-child proof. Inaccessible or incomplete process identities fail closed.
HTTP request completion and cancellation events alone never prove child exit.
The census distinguishes positive exit from denied live inspection. The
registered SYSTEM sandbox broker is verified through Windows service/registry
ownership, its package image and service-manager ancestry; it is not an app/tool
client that must exit. Its actual tool descendants remain relevant and no service
is stopped for maintenance.

The coordinator validates protected conversation ledgers with the runtime's shared
durable-risk projection, rejects every unresolved native action even when its
record is not loaded by the serving Router, requires durable evidence for each
reported uncertain Send, and verifies
their original hashes at selection changes and after reload. It never clears an
uncertainty bit or replays Send.
Historical V1 history fields remain opaque and byte-preserved when the risk
projection is valid. The full resume validator retains its stricter current
history/binding requirements; preservation does not make older history executable.
Only exact UUID mapping filenames carry current conversation risk. Protected
bounded regular recovery sidecars are hashed and preserved as opaque bytes;
their historical contents never become executable state. Links, directories and
unreadable sidecars remain failures, and changes to either mappings or sidecars
withhold maintenance acceptance.
The forced restart revalidates closed admission,
the same Web counters and the live owned Router process before bypassing only its
redundant drain; it cannot force a newly opened admission state. Recovery still
requires the ordinary known-zero Web proof before restoring prior state;
new or uncertain work defers compensation and retains the refreshed generation.
Older drain replies establish neither the normal proof nor this forced exception.
The [independent maintenance entrypoint](../CHATGPT-WEB.md#refresh-after-a-codex-update)
uses the existing protected WMI worker/request/result lifecycle to await a full
normal quit, with actual exit handles followed by a fresh complete census. It
validates the reviewed clean candidate before waiting and after exit, refreshes
before the existing in-process guarded checkout deployment, and applies a final
adapter plan only if changed. The initial refresh compares its own prepared
candidate with the reviewed plan before effects; the final plan must retain that
official runtime cohort. Acceptance records the actual final identities and the
underlying deployment's acceptance and durable rollback receipts.
The successful underlying checkout deployment publishes its ordinary protected
completed owner immediately, independently of the outer Web result. Existing
recovery discovery therefore retains backup custody even if a later Web check fails.
An early reopen aborts before the next selection change. The optional
`-ReopenCodexOnSuccess` records the registered desktop package, manifest and
AppUserModelId at preparation. After all acceptance is validated, the completed
success is durable and the deployment lock is released, it revalidates that exact
registration and invokes Windows registered-app activation with no app arguments.
The separate reopen outcome cannot roll back accepted deployment. Other flows
and this command without the flag never auto-launch Codex. No runtime patch or
global startup hook is involved. Retained generations are preserved for recovery;
removed official runtime files mean the old adapter alone is not a usable Web
rollback, and its live recovery must be verified separately.
The explicit `stop install-adapter` command routes an installed, locally owned
replacement through this same coordinator, including its manifest validation and
browser update. Unresolved ownership or prepared recovery is rejected before
replacement; a first install keeps its existing strict setup prerequisites.

```powershell
.\model-router.ps1 codex web stop adapter-rollback
```

Rollback restores only still-owned launch selections and removes only the owned
adapter hook, preserving foreign edits and the staged files. Fully quit and reopen
Codex afterward. A Codex update needs a fresh compatibility check
for the selected official executables and browser runtime.
