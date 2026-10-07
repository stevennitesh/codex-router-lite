// Read native observations, verify one bounded window, and emit redacted drafts.
// This command never runs a model, accepts proof, or changes route eligibility.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { INSTALL_MANIFEST_PATH } from "../src/paths.mjs";
import { installedSourceRoot } from "../src/install-manifest.mjs";
import { switchyardRuntimeStatus } from "../src/switchyard-runtime.mjs";
import { summarizeSwitchyardCertificationEvidence } from "../src/switchyard-certification-evidence.mjs";
import { latestSwitchyardGeneration } from "../src/switchyard-trace.mjs";
import { certificationPreflight } from "./certification-preflight.mjs";

class EvidenceError extends Error {}
function requireEvidence(condition, message) { if (!condition) throw new EvidenceError(message); }
function instant(value) {
  requireEvidence(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "An observation timestamp must be an exact UTC ISO millisecond instant.");
  return Date.parse(value);
}
function within(row, run) { const at = instant(row.timestamp); return at >= instant(run.startedAt) && at <= instant(run.endedAt); }
// Switchyard's Rust traces can use microseconds. These timestamps are filtered
// precisely, not rewritten into the millisecond proof-observation contract.
function traceInstant(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value || "");
  requireEvidence(match, "A Switchyard trace timestamp is invalid.");
  const base = `${match[1]}.000Z`;
  return BigInt(instant(base)) * 1000000n + BigInt((match[2] || "").padEnd(9,"0"));
}
function traceWithin(at, run) { const value = traceInstant(at); return value >= traceInstant(run.startedAt) && value <= traceInstant(run.endedAt); }
const payload = row => row.payload || {};
const items = rows => rows.filter(row => row.type === "response_item");
const args = row => JSON.parse(payload(row).arguments);
const text = row => (payload(row).content || []).map(part => part.text || "").join("");
const meta = rows => payload(rows.find(row => row.type === "session_meta") || {});
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const canonicalSha = file => createHash("sha256").update(readFileSync(file, "utf8").replace(/\r\n?/gu, "\n")).digest("hex");
function failedEvent(row) {
  return row.type === "event_msg" && (/(?:task|turn)_(?:aborted|cancelled|failed|interrupted)$/u.test(payload(row).type || "") || ["failed","error","cancelled","aborted","interrupted"].includes(payload(row).status));
}

function validateRun(run) {
  requireEvidence(run?.version === 1 && instant(run.startedAt) < instant(run.endedAt), "A version 1 run with an explicit bounded window is required.");
  requireEvidence(typeof run.parentSessionId === "string" && run.parentSessionId.length > 0, "An exact private parent identity is required.");
  requireEvidence(/^[a-f0-9]{40}$/iu.test(run.routerCommit) && path.isAbsolute(run.sourceRoot || ""), "An exact deployed Router commit and source root are required.");
  requireEvidence(/^codex-cli \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(run.codexVersion) && /^\d+\.\d+\.\d+\.\d+$/u.test(run.windowsAppVersion), "Observed Codex CLI and Windows app versions are required.");
  requireEvidence(["codex-cli", "codex-desktop-native"].includes(run.executionSurface) && ["elevated", "mxc"].includes(run.windowsSandbox), "The execution surface and Windows sandbox backend must be explicit.");
  requireEvidence(run.sandboxPolicy === "workspace-write" && run.approvalPolicy === "on-request", "Certification must retain workspace-write and on-request approval.");
  requireEvidence(Array.isArray(run.routes) && run.routes.length > 0, "At least one exact registered route is required.");
  const slugs = new Set();
  for (const spec of run.routes) {
    requireEvidence(MODEL_BY_SLUG.has(spec.slug) && !slugs.has(spec.slug), "Requested routes must be registered and unique.");
    slugs.add(spec.slug);
    for (const marker of [spec.firstMarker, spec.secondMarker]) {
      requireEvidence(typeof marker === "string" && /^[A-Z][A-Z0-9_]{1,120}$/u.test(marker), "Synthetic marker strings are required.");
    }
    requireEvidence(spec.firstMarker !== spec.secondMarker, "The two markers for one child must differ.");
  }
}

function outputFor(call, rows) {
  const outputs = items(rows).filter(row => ["function_call_output", "custom_tool_call_output"].includes(payload(row).type) && payload(row).call_id === payload(call).call_id);
  requireEvidence(outputs.length === 1 && instant(outputs[0].timestamp) >= instant(call.timestamp), "A unique matching tool output after its call is required.");
  return outputs[0];
}

function successfulTool(call, output) {
  const tool = payload(call), result = payload(output).output;
  let command;
  if (tool.type === "function_call" && tool.name === "exec_command") {
    command = args(call);
    requireEvidence(typeof result === "string" && /Process exited with code 0/u.test(result) && /Output:\s*42\s*$/u.test(result), "The native command must exit successfully with output 42.");
  } else {
    requireEvidence(tool.type === "custom_tool_call" && tool.name === "exec", "Only the requested native command or its functions wrapper may count.");
    const wrapped = /^(?:text\()?await tools\.exec_command\((\{[\s\S]*\})\)\)?;?$/u.exec(String(tool.input || "").trim());
    requireEvidence(wrapped, "The functions wrapper must contain only the requested command.");
    try { command = JSON.parse(wrapped[1]); }
    catch { throw new EvidenceError("The functions wrapper must contain only the requested command."); }
    const values = (Array.isArray(result) ? result : []).filter(part => ["input_text", "text"].includes(part.type) && part.text?.startsWith("{")).map(part => JSON.parse(part.text));
    requireEvidence(values.length === 1 && values[0].exit_code === 0 && values[0].output?.trim() === "42", "The wrapped native command must exit successfully with output 42.");
  }
  requireEvidence(command.cmd === "Write-Output (19+23)" && [undefined, "use_default"].includes(command.sandbox_permissions), "The command must use the default sandbox and the synthetic arithmetic fixture.");
}

function routeTimings(routerLog, run) {
  return String(routerLog).split(/\r?\n/u).filter(line => line.includes(" timing ")).map(line => {
    const field = key => new RegExp(`\\b${key}=([^ ]+)`, "u").exec(line)?.[1];
    return { at:field("at"), model:field("model"), provider:field("provider"), status:Number(field("status")), totalMs:Number(field("total_ms")) };
  }).filter(row => row.at && instant(row.at) >= instant(run.startedAt) && instant(row.at) <= instant(run.endedAt));
}

export function extractCertificationEvidence({ run, parent, children, routerLog, installManifest, runtimeBinding, switchyardSummary } = {}) {
  validateRun(run);
  requireEvidence(installManifest?.current?.commit === run.routerCommit && path.resolve(installedSourceRoot(installManifest)).toLowerCase() === path.resolve(run.sourceRoot).toLowerCase(), "The run must match the current protected installation identity.");
  requireEvidence(meta(parent).id === run.parentSessionId && meta(parent).cli_version === run.codexVersion.slice("codex-cli ".length), "The parent rollout must match the declared identity and CLI build.");
  const parentWindow = parent.filter(row => row.type !== "session_meta" && within(row, run));
  requireEvidence(!parentWindow.some(failedEvent), "The selected parent window must not contain aborted, failed or cancelled turns.");
  const parentContexts = parentWindow.filter(row => row.type === "turn_context");
  requireEvidence(parentContexts.length > 0 && parentContexts.every(row => /^gpt-/u.test(payload(row).model) && payload(row).sandbox_policy?.type === run.sandboxPolicy && payload(row).approval_policy === run.approvalPolicy), "A native parent must retain the declared sandbox and approval policy.");
  const parentCompletions = parentWindow.filter(row => row.type === "event_msg" && payload(row).type === "task_complete");
  requireEvidence(parentCompletions.length === 1, "The native parent must complete successfully once within the declared window.");
  const parentItems = items(parentWindow);
  const spawns = parentItems.filter(row => payload(row).type === "function_call" && payload(row).name === "spawn_agent");
  requireEvidence(spawns.length === run.routes.length, "The window must contain exactly the requested child spawns.");
  const timings = routeTimings(routerLog, run);
  const childIdentities = new Set();
  const reports = run.routes.map(spec => {
    const route = MODEL_BY_SLUG.get(spec.slug), role = routedAgentDefinition(route).agentName;
    const matching = spawns.filter(row => args(row).agent_type === role);
    requireEvidence(matching.length === 1, "Each exact route must have one matching native spawn.");
    const spawn = matching[0], spawnArgs = args(spawn);
    requireEvidence(spawnArgs.fork_turns === "none" && spawnArgs.model === undefined && spawnArgs.reasoning_effort === undefined, "The spawn must use the generated role and isolated conversation without overrides.");
    const matchingChildren = children.filter(rows => meta(rows).parent_thread_id === run.parentSessionId && meta(rows).agent_role === role);
    requireEvidence(matchingChildren.length === 1, "Both turns must belong to one exact child rollout.");
    const child = matchingChildren[0], childMeta = meta(child);
    requireEvidence(child.filter(row => row.type === "session_meta").length === 1 && typeof childMeta.id === "string" && childMeta.id.length > 0, "A child rollout must preserve one session identity.");
    requireEvidence(!childIdentities.has(childMeta.id), "Different exact routes must use different child identities.");
    childIdentities.add(childMeta.id);
    const spawnResult = JSON.parse(payload(outputFor(spawn, parentWindow)).output);
    requireEvidence(childMeta.agent_path === `/root/${spawnArgs.task_name}` && spawnResult.task_name === childMeta.agent_path, "The parent spawn result must identify the observed child.");
    const observed = child.filter(row => row.type !== "session_meta" && within(row, run));
    requireEvidence(!observed.some(failedEvent), "The selected child window must not contain aborted, failed or cancelled turns.");
    const contexts = observed.filter(row => row.type === "turn_context");
    requireEvidence(contexts.length === 2 && contexts.every(row => payload(row).model === spec.slug && payload(row).effort === route.defaultEffort && payload(row).sandbox_policy?.type === run.sandboxPolicy && payload(row).approval_policy === run.approvalPolicy), "Both child turns must preserve the exact route, pinned effort, sandbox and approval policy.");
    const childItems = items(observed);
    const handoffs = childItems.filter(row => payload(row).type === "agent_message" && payload(row).content?.some(part => part.type === "encrypted_content"));
    const finals = childItems.filter(row => payload(row).type === "message" && payload(row).role === "assistant" && payload(row).phase === "final_answer");
    const completions = observed.filter(row => row.type === "event_msg" && payload(row).type === "task_complete");
    requireEvidence(handoffs.length === 2 && finals.length === 2 && completions.length === 2 && text(finals[0]) === spec.firstMarker && text(finals[1]) === spec.secondMarker, "The same child must receive two encrypted handoffs and complete both requested markers.");
    const calls = childItems.filter(row => ["function_call", "custom_tool_call"].includes(payload(row).type));
    requireEvidence(calls.length === 1, "Exactly one synthetic native command is required.");
    const call = calls[0], output = outputFor(call, observed);
    successfulTool(call, output);
    const childTargets = new Set([spawnArgs.task_name,childMeta.agent_path,childMeta.id,spawnResult.agent_id].filter(Boolean));
    const follows = parentItems.filter(row => payload(row).name === "followup_task" && childTargets.has(args(row).target));
    requireEvidence(follows.length === 1 && instant(follows[0].timestamp) >= instant(completions[0].timestamp) && instant(follows[0].timestamp) <= instant(handoffs[1].timestamp), "The same-child follow-up must occur after the first turn completes.");
    const followOutput = payload(outputFor(follows[0],parentWindow)).output;
    // Native CLI followup_task returns an empty acknowledgement. Delivery is
    // established by its exact target, subsequent encrypted handoff, pinned
    // second child context and completed marker, all checked here. When a
    // runtime provides a structured acknowledgement, retain its identity and
    // failure checks rather than treating arbitrary text as success.
    if (followOutput !== "") {
      let followResult;
      try { followResult = JSON.parse(followOutput); }
      catch { throw new EvidenceError("The follow-up acknowledgement is neither empty nor valid structured evidence."); }
      requireEvidence(followResult?.task_name === childMeta.agent_path && followResult.error == null && followResult.isError !== true && followResult.success !== false && !["failed","error","cancelled","aborted"].includes(followResult.status), "The follow-up must successfully return the same child identity.");
    }
    for (let index = 0; index < 2; index++) {
      requireEvidence(instant(handoffs[index].timestamp) <= instant(finals[index].timestamp) && instant(finals[index].timestamp) <= instant(completions[index].timestamp), "Each marker must follow its handoff and precede its completed turn.");
    }
    requireEvidence(instant(spawn.timestamp) <= instant(handoffs[0].timestamp) && instant(handoffs[0].timestamp) <= instant(call.timestamp) && instant(output.timestamp) <= instant(finals[0].timestamp), "The command and first marker must follow the native spawn and first handoff.");
    const cleanups = parentItems.filter(row => payload(row).name === "interrupt_agent" && childTargets.has(args(row).target));
    requireEvidence(cleanups.length <= 2, "Unexpected child cleanup calls are not proof of a completed lifecycle.");
    for (const cleanup of cleanups) {
      const result = JSON.parse(payload(outputFor(cleanup, parentWindow)).output);
      const index = result.previous_status?.completed === spec.firstMarker ? 0 : result.previous_status?.completed === spec.secondMarker ? 1 : -1;
      requireEvidence(index >= 0 && instant(cleanup.timestamp) >= instant(completions[index].timestamp), "Cleanup must observe an already-completed child, never active cancellation.");
    }
    const end = completions[1].timestamp;
    const routeRows = timings.filter(row => row.model === spec.slug);
    requireEvidence(routeRows.length >= 3 && routeRows.every(row => row.provider === route.provider && row.status >= 200 && row.status < 300 && Number.isFinite(row.totalMs) && row.totalMs >= 0 && instant(row.at) >= instant(spawn.timestamp) && instant(row.at) <= instant(end)), "The exact route window must contain only successful matching-provider Router timings for this completed child.");
    const pass = at => ({outcome:"pass",status:routeRows.at(-1).status,observedAt:at});
    const proof = certificationPreflight(route, {deployedCommit:run.routerCommit}).draftProof;
    // Rollout snapshots and successful timings do not establish SSE transport.
    // Preserve the template's pending streaming check for separate observation.
    Object.assign(proof, {testedAt:end,routerVersion:installManifest.current.packageVersion,codexVersion:run.codexVersion,windowsAppVersion:run.windowsAppVersion,executionSurface:run.executionSurface,windowsSandbox:run.windowsSandbox,sandboxPolicy:run.sandboxPolicy,approvalPolicy:run.approvalPolicy,checks:{...proof.checks,toolCall:{...pass(output.timestamp),mode:"auto"},encryptedRelay:pass(handoffs[1].timestamp),markerReturn:pass(finals[0].timestamp),sameThreadFollowUp:pass(finals[1].timestamp)}});
    if (route.provider === "switchyard") {
      requireEvidence(runtimeBinding?.routerCommit === run.routerCommit && ["upstreamCommit","upstreamContributionCommit"].every(key => /^[a-f0-9]{40}$/iu.test(runtimeBinding[key])) && ["upstreamContributionSha256","patchSha256","binarySha256","routesSha256","templateSha256","templateSourceSha256"].every(key => /^[a-f0-9]{64}$/iu.test(runtimeBinding[key])) && switchyardSummary?.routing?.uniqueSessions === 1 && switchyardSummary.routing.total === routeRows.length && switchyardSummary.failures && Object.values(switchyardSummary.failures).every(value => value === 0), "Switchyard needs verified runtime binding and one successful routing session for this window.");
      proof.runtimeBinding = runtimeBinding;
    }
    return {slug:spec.slug,role,effort:route.defaultEffort,startedAt:spawn.timestamp,endedAt:end,nativeParentSpawnObserved:true,sameChildRollout:true,encryptedHandoffCount:2,tool:{name:"exec_command",output:"42",outputAt:output.timestamp,success:true,defaultSandbox:true,callOutputIdentityMatched:true},finals:finals.map(row => ({at:row.timestamp,marker:text(row)})),timings:routeRows,lifecycle:{completedTurns:2,completedCleanupCalls:cleanups.length,activeTurnCancelled:false},draftProof:proof};
  });
  requireEvidence(reports.every(report => instant(parentCompletions[0].timestamp) >= instant(report.endedAt)), "The native parent must finish after every verified child completes.");
  requireEvidence(typeof installManifest.current.packageVersion === "string" && /^\d+\.\d+\.\d+$/u.test(installManifest.current.packageVersion), "The protected installation must record its Router version.");
  return {version:1,historical:true,status:"draft",routerCommit:run.routerCommit,routerVersion:installManifest.current.packageVersion,codexVersion:run.codexVersion,windowsAppVersion:run.windowsAppVersion,executionSurface:run.executionSurface,windowsSandbox:run.windowsSandbox,sandboxPolicy:run.sandboxPolicy,approvalPolicy:run.approvalPolicy,reports,limits:["Synthetic native collaboration for the named execution surface and declared backend only.","Streaming remains pending until separately observed; timings and rollout snapshots do not prove SSE transport.","Draft observations do not accept proof or promote route eligibility.","Raw transcript payloads, ciphertext, private identities and paths are omitted."]};
}

function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function rows(file) { return readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse); }
function firstRow(file) {
  const fd = openSync(file, "r"), buffer = Buffer.alloc(4096);
  let first = "";
  try {
    while (!first.includes("\n") && first.length < 65536) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      first += buffer.subarray(0, count).toString("utf8");
    }
    requireEvidence(first.includes("\n") || first.length < 65536, "A child rollout header exceeds the supported bounded read.");
    return JSON.parse(first.split("\n")[0]);
  } finally { closeSync(fd); }
}

function verifiedRuntime(run, manifest) {
  const root = installedSourceRoot(manifest);
  requireEvidence(manifest.current.commit === run.routerCommit && path.resolve(root).toLowerCase() === path.resolve(run.sourceRoot).toLowerCase(), "The run must match the current protected installation identity.");
  for (const spec of run.routes) {
    const installed = json(path.join(root, "config", `${spec.slug}.json`)).models?.find(route => route.slug === spec.slug);
    const current = MODEL_BY_SLUG.get(spec.slug);
    const binding = route => { const {multiAgentVersion: _windowEligibility, ...rest} = route || {}; return rest; };
    requireEvidence(installed, "The installed exact route record is missing.");
    try { assert.deepEqual(binding(installed), binding(current)); }
    catch { throw new EvidenceError("The installed exact route policy differs from the source candidate."); }
  }
  if (!run.routes.some(spec => MODEL_BY_SLUG.get(spec.slug).provider === "switchyard")) return undefined;
  const runtime = switchyardRuntimeStatus();
  requireEvidence(runtime.ready, "The Switchyard runtime is not readable.");
  const binding = json(path.join(runtime.runtimeRoot, "provenance.json")), lock = json(path.join(root, "config/switchyard/source.lock"));
  const equalities = [
    [binding.routerCommit,run.routerCommit],[binding.upstreamCommit,lock.commit],
    [binding.upstreamContributionCommit,lock.upstreamContribution.sourceCommit],
    [binding.upstreamContributionSha256,lock.upstreamContribution.patchSha256],
    [binding.patchSha256,lock.patchSha256],[binding.binarySha256,sha(runtime.binary)],
    [binding.routesSha256,sha(runtime.config)],
    [binding.patchSha256,sha(path.join(root,"config/switchyard",lock.patch))],
    [binding.upstreamContributionSha256,sha(path.join(root,"config/switchyard",lock.upstreamContribution.patch))],
    [binding.templateSha256,sha(path.join(root,"config/switchyard/routes.template.toml"))],
    [binding.templateSourceSha256,canonicalSha(path.join(root,"config/switchyard/routes.template.toml"))],
  ];
  requireEvidence(equalities.every(([actual, expected]) => typeof actual === "string" && actual === expected), "Switchyard runtime hashes or pinned source binding differ.");
  // Whitelist binding fields: the private provenance record may gain other state.
  return Object.fromEntries(["upstreamCommit","upstreamContributionCommit","upstreamContributionSha256","routerCommit","patchSha256","binarySha256","routesSha256","templateSha256","templateSourceSha256"].map(key => [key,binding[key]]));
}

function boundedSwitchyardSummary(run, routerLog) {
  const generation = latestSwitchyardGeneration(routerLog);
  requireEvidence(generation, "The Switchyard server generation was not observed.");
  let at;
  const lines = generation.split(/\r?\n/u).filter((line, index) => {
    if (index === 0) return true;
    at = /\bat=([^ ]+)/u.exec(line)?.[1] || /^(\d{4}-\d{2}-\d{2}T[^ ]+Z)/u.exec(line)?.[1] || at;
    return at && traceWithin(at,run);
  });
  const runtime = switchyardRuntimeStatus();
  const routingLog = readFileSync(path.join(runtime.runtimeRoot, "routing.jsonl"), "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter(row => traceWithin(row.ts,run)).map(row => JSON.stringify(row)).join("\n");
  return summarizeSwitchyardCertificationEvidence({routerLog:lines.join("\n"),routingLog,limit:100});
}

export function collectCertificationEvidence({run, parentPath, childrenDirs, routerLogPath}) {
  validateRun(run);
  const manifest = json(INSTALL_MANIFEST_PATH), runtimeBinding = verifiedRuntime(run, manifest);
  const children = childrenDirs.flatMap(childrenDir => readdirSync(childrenDir).filter(name => name.endsWith(".jsonl")).flatMap(name => {
    const file = path.join(childrenDir,name), header = firstRow(file);
    return header.type === "session_meta" && payload(header).parent_thread_id === run.parentSessionId ? [rows(file)] : [];
  }));
  const routerLog = readFileSync(routerLogPath, "utf8");
  return extractCertificationEvidence({run,parent:rows(parentPath),children,routerLog,installManifest:manifest,runtimeBinding,switchyardSummary:runtimeBinding ? boundedSwitchyardSummary(run,routerLog) : undefined});
}

function main(argv) {
  requireEvidence(argv[0] === "extract", "Usage: certification-evidence.mjs extract --run FILE --parent FILE --children DIR --router-log FILE --output FILE");
  const options = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    requireEvidence(["--run","--parent","--children","--router-log","--output"].includes(argv[index]) && argv[index + 1] && !options.has(argv[index]), "Five unique extraction paths are required.");
    options.set(argv[index], path.resolve(argv[index + 1]));
  }
  requireEvidence(options.size === 5, "Five unique extraction paths are required.");
  const outputPath = options.get("--output"), childrenDir = options.get("--children");
  requireEvidence(![...options].some(([key, value]) => key !== "--output" && (value === outputPath || key === "--children" && path.dirname(outputPath) === childrenDir)), "The output must not replace a private input artifact.");
  const summary = collectCertificationEvidence({run:json(options.get("--run")),parentPath:options.get("--parent"),childrenDirs:[childrenDir],routerLogPath:options.get("--router-log")});
  // Exclusive creation leaves previous results intact.
  writeFileSync(outputPath, `${JSON.stringify(summary,null,2)}\n`, {flag:"wx"});
  console.log(JSON.stringify({status:"draft",routes:summary.reports.map(report => report.slug)}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof EvidenceError ? error.message : `Certification evidence could not be verified${error.code ? ` (${error.code})` : ""}.`);
    process.exitCode = 1;
  }
}
