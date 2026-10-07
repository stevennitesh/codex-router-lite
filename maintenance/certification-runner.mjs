// Authorized synthetic checks, followed by reviewed publication. No route or
// persistent Codex setting is changed by the runner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { certificationBatchPreflight, certificationRoutes } from "./certification-preflight.mjs";
import { collectCertificationEvidence } from "./certification-evidence.mjs";
import { validateV2AgentApplications } from "../scripts/check-v2-agent-applications.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { codexExecutableIdentity, assertCodexExecutableIdentity } from "../src/codex-binary.mjs";
import { nativeAccountCatalogHeaders } from "../src/codex-native-session.mjs";
import { protectPrivateFile, writePrivateFile, writePrivateJson } from "../src/file-security.mjs";
import { CALLER_SECRET_PATH, CODEX_HOME, LOG_PATH, PORTS, SOURCE_ROOT } from "../src/paths.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";

const json = file => JSON.parse(readFileSync(file, "utf8"));
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
class CertificationRunnerError extends Error {}
const requireCondition = (condition, message) => { if (!condition) throw new CertificationRunnerError(message); };
const USAGE = "certification-runner.mjs run --output generated/NEW --windows-sandbox mxc|elevated --allow-live [--switchyard-smoke] <route ...>|--all; publish --draft FILE --evidence docs/history/NEW.json --reviewed";

export function parseCertificationRunnerArguments(argv) {
  const [command, ...args] = argv, options = {}, routes = [];
  requireCondition(["run", "publish"].includes(command), USAGE);
  const valueOptions = command === "run" ? ["--output", "--windows-sandbox"] : ["--draft", "--evidence"];
  const flags = command === "run" ? ["--allow-live", "--switchyard-smoke"] : ["--reviewed"];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valueOptions.includes(arg)) {
      requireCondition(!Object.hasOwn(options, arg) && args[index + 1] && !args[index + 1].startsWith("--"), USAGE);
      options[arg] = args[++index];
    } else if (flags.includes(arg)) {
      requireCondition(!options[arg], USAGE); options[arg] = true;
    } else {
      requireCondition(command === "run" && (arg === "--all" || !arg.startsWith("--")), USAGE); routes.push(arg);
    }
  }
  if (command === "run") {
    requireCondition(options["--allow-live"] && options["--output"] && ["mxc", "elevated"].includes(options["--windows-sandbox"]), USAGE);
    const selected = certificationRoutes(routes);
    requireCondition(!options["--switchyard-smoke"] || selected.some(route => route.provider === "switchyard"), "Switchyard smoke requires the Switchyard route in this run.");
    return { command, directory:path.resolve(options["--output"]), sandbox:options["--windows-sandbox"], smoke:Boolean(options["--switchyard-smoke"]), routes:selected };
  }
  requireCondition(options["--reviewed"] && options["--draft"] && options["--evidence"], USAGE);
  return { command, draft:path.resolve(options["--draft"]), evidence:path.resolve(options["--evidence"]) };
}

export function certificationParentPrompt(reports) {
  return `Perform exactly ${reports.length} synthetic native collaboration sequences, sequentially. The human has authorized these exact spawns and follow-ups. Use only native collaboration tools and the assigned command. Do not browse, read project files, edit files, request escalation, retry a failed route, substitute models, or use app create_thread.

For each exact role below, spawn_agent with that agent_type, fork_turns "none", a fresh task_name, and no model or reasoning_effort override. Assign the child: run exec_command exactly once with cmd "Write-Output (19+23)" and default sandbox permissions. Verify actual output 42 and exit code 0, then return only CERT_FIRST_OK. If offered only through functions.exec, use exactly text(await tools.exec_command({"cmd":"Write-Output (19+23)","sandbox_permissions":"use_default"})); with no other wrapper work. On failure report the actual failure instead of the marker.

Wait for the completed first turn. If interrupt_agent cleanup is required, call it only after completion and verify previous_status is completed. Never cancel an active turn. Call followup_task on the SAME child: return only CERT_SECOND_OK, without tools. Wait for completion and clean up that completed child. On a failure continue to the next role without retry. Report the actual results briefly.

${reports.map(report => `- ${report.role}; exact route ${report.slug}; pinned effort ${report.effort}.`).join("\n")}`;
}

// Incremental SSE observation: snapshots or HTTP 200 alone cannot satisfy it.
export async function observeCertificationStream(response) {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body?.cancel();
    throw new CertificationRunnerError("The synthetic response is not an HTTP 200 event stream.");
  }
  let pending = "", visible = "", bytes = 0, events = 0, textDeltas = 0, terminal;
  const decoder = new TextDecoder();
  function line(value) {
    if (!value.startsWith("data:")) return;
    const data = value.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data); events++;
    requireCondition(!terminal, "The synthetic stream emitted an event after its terminal response.");
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") { textDeltas++; visible += event.delta; }
    if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) terminal = event;
  }
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    requireCondition(bytes <= 8 * 1024 * 1024, "The synthetic stream exceeded its byte limit.");
    pending += decoder.decode(chunk, {stream:true});
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) { line(pending.slice(0,newline).replace(/\r$/u,"")); pending = pending.slice(newline + 1); }
  }
  pending += decoder.decode(); if (pending) line(pending.replace(/\r$/u,""));
  const markerObserved = visible.trim() === "CERT_STREAM_OK";
  requireCondition(textDeltas > 0 && terminal?.type === "response.completed" && terminal.response?.status === "completed" && markerObserved, "The synthetic stream lacks text deltas, a completed response, or the requested marker.");
  return {status:response.status,events,textDeltas,terminalType:terminal.type,returnedModel:terminal.response.model,markerObserved,pass:true};
}

export function completeCertificationDraft(summary, streaming) {
  requireCondition(summary.status === "draft" && streaming.routerCommit === summary.routerCommit && streaming.codexVersion === summary.codexVersion && streaming.windowsAppVersion === summary.windowsAppVersion, "Streaming and native observations must have the same runtime identity.");
  assert.deepEqual(streaming.reports.map(report => report.slug).sort(), summary.reports.map(report => report.slug).sort(), "Streaming observations must cover exactly the selected native routes.");
  const reports = summary.reports.map(report => {
    const observed = streaming.reports.find(row => row.slug === report.slug);
    requireCondition(observed.routerCommit === summary.routerCommit && observed.pass === true && observed.status === 200 && observed.textDeltas > 0 && observed.terminalType === "response.completed" && observed.markerObserved === true && iso(observed.startedAt) && iso(observed.endedAt) && observed.startedAt <= observed.endedAt && observed.endedAt <= report.startedAt, "A route needs separately observed successful streaming before its native child sequence.");
    const proof = structuredClone(report.draftProof);
    proof.checks.streaming = {outcome:"pass",status:observed.status,observedAt:observed.endedAt};
    requireCondition(proof.status === "draft" && Object.values(proof.checks).every(check => check.outcome === "pass"), "Every required native check must pass before producing a complete draft.");
    return {...report,streaming:observed,draftProof:proof};
  });
  return {...summary,reports,limits:["Synthetic native CLI collaboration for the named backend only; desktop and arbitrary MCP tools are outside this proof.","Streaming was observed separately on the same deployed generation.","Completed drafts require review before acceptance. Raw transcripts and private identities remain local."]};
}

export function renderCertificationProof(report, {evidenceLink, guideLink}) {
  const proof = report.draftProof || report.proof;
  return `# ${proof.slug} v2 certification

${proof.status === "accepted" ? "Accepted" : "Draft; review required"} observations against Router \`${proof.routerCommit}\`
(version ${proof.routerVersion}), ${proof.codexVersion}, Windows app ${proof.windowsAppVersion}.
Tested at ${proof.testedAt}. ${proof.endpointProvider ? `Exact endpoint: \`${proof.endpointProvider}\`; fallback disabled.` : "Switchyard runtime identities are recorded in proof.json."}

## Evidence

[Redacted run evidence](${evidenceLink}) records role \`${report.role}\`, effort
\`${report.effort}\`, output 42 from a real sandboxed command, two encrypted
handoffs, and both markers from the same child. ${report.timings.length} Router requests
completed successfully. ${report.lifecycle.completedCleanupCalls} cleanup calls observed
already-completed turns; no active turn was cancelled.

| Check | Result |
| --- | --- |
| Streamed text and completion | ${proof.checks.streaming.outcome} |
| Actual native tool and output | ${proof.checks.toolCall.outcome} |
| Encrypted parent-to-child relay | ${proof.checks.encryptedRelay.outcome} |
| First marker | ${proof.checks.markerReturn.outcome} |
| Same-child follow-up | ${proof.checks.sameThreadFollowUp.outcome} |

## Scope and reproduction

The native CLI used session-only \`windows.sandbox="${proof.windowsSandbox}"\`,
workspace-write, and on-request approval. The runner did not change persistent
configuration. This certifies the named CLI path; desktop sandbox behavior,
arbitrary MCP tools, exhaustive schemas and model reliability are outside the run.
Follow [certification](${guideLink}) for reproduction and refresh conditions.
Raw transcripts, ciphertext and session identifiers are omitted.
`;
}

function powershell(script, environment = {}) {
  const result = spawnSync("powershell.exe", ["-NoLogo","-NoProfile","-NonInteractive","-Command",script], {windowsHide:true,encoding:"utf8",timeout:15000,env:{...process.env,...environment}});
  requireCondition(!result.error && result.status === 0, "The Windows certification context could not be verified.");
  return result.stdout.trim();
}

export async function executeCertificationParent(identity, batch, directory, sandbox, {timeoutMs = 20 * 60 * 1000, launch = spawn} = {}) {
  const prompt = certificationParentPrompt(batch.reports);
  const eventsPath = path.join(directory,"parent-events.jsonl"), errorsPath = path.join(directory,"parent-stderr.log"), finalPath = path.join(directory,"parent-final.txt");
  writePrivateFile(path.join(directory,"parent-prompt.txt"),prompt);
  for (const file of [eventsPath,errorsPath,finalPath]) { requireCondition(!existsSync(file), "A private parent artifact already exists."); writePrivateFile(file,""); }
  const events = openSync(eventsPath,"a"), errors = openSync(errorsPath,"a");
  let child, timer, deadlineExpired = false;
  try {
    const args = ["exec","--json","--skip-git-repo-check","--sandbox","workspace-write","--model","gpt-6.1-sol","--config",'model_reasoning_effort="medium"',"--config",'approval_policy="on-request"',"--config",`windows.sandbox="${sandbox}"`,"--cd",directory,"--output-last-message",finalPath,"-"];
    const target = spawnableCommand(identity.binary,args);
    child = launch(target.command,target.args,{...target.options,windowsHide:true,stdio:["pipe",events,errors]});
    const completion = new Promise((resolve,reject) => { child.once("error",reject); child.once("close",(code,signal) => resolve({exitCode:code,signal})); });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    timer = setTimeout(() => {
      deadlineExpired = true;
      // Keep the live parent PID until its tree is terminated; killing only
      // the parent first can leave tool/MCP descendants behind on Windows.
      if (process.platform === "win32") spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore",timeout:10000});
      if (child.exitCode === null) child.kill();
    },timeoutMs);
    const outcome = {...await completion,deadlineExpired};
    writePrivateJson(path.join(directory,"parent-exit.json"),outcome);
    requireCondition(outcome.exitCode === 0 && !deadlineExpired, "The native certification parent failed or exceeded its deadline; no proof was produced.");
    requireCondition(statSync(eventsPath).size <= 64 * 1024 * 1024, "The parent event journal exceeded its read limit.");
    const rows = readFileSync(eventsPath,"utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
    const sessions = rows.filter(row => row.type === "thread.started");
    requireCondition(sessions.length === 1 && typeof sessions[0].thread_id === "string", "The native parent did not identify one session.");
    return sessions[0].thread_id;
  } finally {
    clearTimeout(timer); closeSync(events); closeSync(errors);
    protectPrivateFile(finalPath);
  }
}

export function certificationSessionDirectories(run, codexHome = CODEX_HOME) {
  const first = Date.parse(run.startedAt), last = Date.parse(run.endedAt);
  requireCondition(last >= first && last - first <= 60 * 60 * 1000, "The native run must fit one bounded hour.");
  // Windows rollout folders may follow local dates while observations are UTC.
  // Consider only dates touched by this bounded run, without a global scan.
  const localDate = value => { const date = new Date(value); return [date.getFullYear(),String(date.getMonth()+1).padStart(2,"0"),String(date.getDate()).padStart(2,"0")].join("-"); };
  return [...new Set([run.startedAt.slice(0,10),run.endedAt.slice(0,10),localDate(run.startedAt),localDate(run.endedAt)])].map(date => path.join(codexHome,"sessions",...date.split("-"))).filter(existsSync);
}

function writeProofs(summary, applicationsRoot, evidencePath, {linkApplicationsRoot = applicationsRoot, sourceRoot = SOURCE_ROOT} = {}) {
  for (const report of summary.reports) {
    const directory = path.join(applicationsRoot,report.slug); mkdirSync(directory,{recursive:true});
    const proof = report.draftProof || report.proof;
    writeFileSync(path.join(directory,"proof.json"),`${JSON.stringify(proof,null,2)}\n`);
    const relative = target => path.relative(path.join(linkApplicationsRoot,report.slug),target).replaceAll("\\","/");
    writeFileSync(path.join(directory,"proof.md"),renderCertificationProof(report,{evidenceLink:relative(evidencePath),guideLink:relative(path.join(sourceRoot,"docs/SUBAGENT-CERTIFICATION.md"))}));
  }
}

export async function runCertification(options) {
  requireCondition(process.platform === "win32", "The maintained runner requires the Windows native CLI.");
  const generated = path.join(SOURCE_ROOT,"generated");
  requireCondition(path.dirname(options.directory) === generated && !existsSync(options.directory), "Use a new direct child directory under generated/ for each run.");
  requireCondition(!existsSync(generated) || !lstatSync(generated).isSymbolicLink(), "The generated directory must not be a link.");
  const batch = certificationBatchPreflight(options.routes);
  requireCondition(batch.readyForFreshParent, "Route preflight is blocked; run certification-preflight.mjs for the selected routes.");
  const identity = codexExecutableIdentity(); assertCodexExecutableIdentity(identity);
  const windowsAppVersion = powershell("(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).Version.ToString()");
  requireCondition(/^\d+\.\d+\.\d+\.\d+$/u.test(windowsAppVersion), "The Windows app version was not observed.");
  mkdirSync(options.directory,{recursive:true});
  powershell("$ErrorActionPreference='Stop'; $user=[Security.Principal.WindowsIdentity]::GetCurrent(); $owner=[IO.Directory]::GetAccessControl($env:CODEX_ROUTER_CERTIFICATION_DIRECTORY).GetOwner([Security.Principal.SecurityIdentifier]); if ($user.Name -match 'CodexSandbox' -or $owner.Value -ne $user.User.Value) { throw 'Use a fresh workspace created by the normal Windows user' }",{CODEX_ROUTER_CERTIFICATION_DIRECTORY:options.directory});
  const save = (name,value) => writePrivateJson(path.join(options.directory,name),value);
  save("result.json",{status:"running",routes:options.routes.map(route => route.slug)});
  try {
    const headers = await nativeAccountCatalogHeaders(); requireCondition(headers, "Native authentication is unavailable.");
    const base = callerBaseUrl(PORTS.router,readFileSync(CALLER_SECRET_PATH,"utf8").trim());
    const streaming = {version:1,routerCommit:batch.runManifestTemplate.routerCommit,codexVersion:identity.version,windowsAppVersion,reports:[]};
    for (const report of batch.reports) {
      const startedAt = new Date().toISOString();
      const response = await fetch(`${base}/responses`,{method:"POST",headers:{"Content-Type":"application/json",...headers,"session-id":`synthetic-cert-${randomUUID()}`},body:JSON.stringify({model:report.slug,input:[{role:"user",content:"Reply with exactly CERT_STREAM_OK."}],instructions:"Synthetic transport verification. Return only the requested marker.",store:false,stream:true}),signal:AbortSignal.timeout(120000)});
      const observed = await observeCertificationStream(response);
      streaming.reports.push({slug:report.slug,routerCommit:streaming.routerCommit,startedAt,endedAt:new Date().toISOString(),...observed});
      save("streaming.json",streaming);
    }
    const run = {...batch.runManifestTemplate,startedAt:new Date().toISOString(),codexVersion:identity.version,windowsAppVersion,executionSurface:"codex-cli",windowsSandbox:options.sandbox,persistentConfigurationChanged:false};
    save("run.json",run);
    run.parentSessionId = await executeCertificationParent(identity,batch,options.directory,options.sandbox);
    run.endedAt = new Date().toISOString(); save("run.json",run);
    assertCodexExecutableIdentity(identity);
    const dirs = certificationSessionDirectories(run);
    const parents = dirs.flatMap(dir => readdirSync(dir).filter(name => name.endsWith(`${run.parentSessionId}.jsonl`)).map(name => path.join(dir,name)));
    requireCondition(parents.length === 1, "The private parent rollout could not be identified uniquely.");
    const summary = completeCertificationDraft(collectCertificationEvidence({run,parentPath:parents[0],childrenDirs:dirs,routerLogPath:LOG_PATH}),streaming);
    for (const report of summary.reports) {
      const existing = path.join(SOURCE_ROOT,"v2_agent",report.slug,"proof.json");
      if (!report.draftProof.officialSources.length && existsSync(existing)) report.draftProof.officialSources = json(existing).officialSources;
    }
    if (options.smoke) {
      const output = path.join(options.directory,"switchyard-live.json");
      const smoke = spawnSync(process.execPath,[path.join(SOURCE_ROOT,"scripts/verify-switchyard-live.mjs"),output],{windowsHide:true,stdio:"ignore",timeout:180000});
      requireCondition(!smoke.error && smoke.status === 0, "The additional Switchyard smoke checks failed.");
      protectPrivateFile(output);
      const evidence = json(output);
      requireCondition(evidence.binding.routerCommit === summary.routerCommit && evidence.requiredFailures.length === 0, "Switchyard smoke must pass on the same deployed generation.");
      const {priorInvalidFixture:_historicalFixture,...current} = evidence;
      summary.switchyardLive = current;
    }
    const draftPath = path.join(options.directory,"drafts.json"); save("drafts.json",summary);
    writeProofs(summary,path.join(options.directory,"review/v2_agent"),draftPath);
    save("result.json",{status:"draft",routes:summary.reports.map(report => report.slug)});
    return {status:"draft",routes:summary.reports.map(report => report.slug),draft:draftPath};
  } catch (error) {
    save("result.json",{status:"failed",routes:options.routes.map(route => route.slug)}); throw error;
  }
}

export function publishCertificationDraft(draft, evidencePath, {sourceRoot = SOURCE_ROOT, copy = copyFileSync} = {}) {
  const history = path.join(sourceRoot,"docs/history");
  requireCondition(path.dirname(evidencePath) === history && path.extname(evidencePath) === ".json" && !existsSync(evidencePath), "Use a new evidence JSON directly under docs/history/.");
  requireCondition(draft?.status === "draft" && draft.reports?.length > 0, "Reviewed complete drafts are required.");
  const routes = certificationRoutes(draft.reports.map(report => report.slug));
  // Drafts are persisted and reviewed between commands. Publish only the
  // extractor's redacted fields, rather than copying arbitrary added metadata.
  const fields = ["version","historical","routerCommit","routerVersion","codexVersion","windowsAppVersion","executionSurface","windowsSandbox","sandboxPolicy","approvalPolicy","limits"];
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value || {},key)).map(key => [key,structuredClone(value[key])]));
  const proofFields = ["version","provider","model","slug","status","officialSources","testedAt","routerVersion","routerCommit","codexVersion","executionSurface","endpointProvider","runtimeBinding","checks","windowsAppVersion","windowsSandbox","sandboxPolicy","approvalPolicy"];
  const reports = draft.reports.map(report => ({...pick(report,["slug","role","effort","startedAt","endedAt","nativeParentSpawnObserved","sameChildRollout","encryptedHandoffCount"]),
    tool:pick(report.tool,["name","output","outputAt","success","defaultSandbox","callOutputIdentityMatched"]),
    finals:report.finals.map(row => pick(row,["at","marker"])),
    timings:report.timings.map(row => pick(row,["at","model","provider","status","totalMs"])),
    lifecycle:pick(report.lifecycle,["completedTurns","completedCleanupCalls","activeTurnCancelled"]),
    streaming:pick(report.streaming,["slug","routerCommit","startedAt","endedAt","status","events","textDeltas","terminalType","returnedModel","markerObserved","pass"]),
    draftProof:pick(report.draftProof,proofFields),
  }));
  for (const report of reports) {
    report.draftProof.checks = Object.fromEntries(["streaming","toolCall","encryptedRelay","markerReturn","sameThreadFollowUp"].map(key => [key,pick(report.draftProof.checks?.[key],["outcome","status","observedAt","mode","completion"])]));
    if (report.draftProof.runtimeBinding) report.draftProof.runtimeBinding = pick(report.draftProof.runtimeBinding,["upstreamCommit","upstreamContributionCommit","upstreamContributionSha256","routerCommit","patchSha256","binarySha256","routesSha256","templateSha256","templateSourceSha256"]);
  }
  const evidence = {...Object.fromEntries(fields.map(key => [key,structuredClone(draft[key])])),status:"accepted",reports};
  if (draft.switchyardLive) evidence.switchyardLive = Object.fromEntries(["testedAt","binding","ordinaryToolRoundTrip","nativeMediaControl","mediaFallback","nativeCompaction","classifier","requiredFailures"].map(key => [key,structuredClone(draft.switchyardLive[key])]));
  for (const report of evidence.reports) {
    requireCondition(Object.values(report.draftProof.checks).every(check => check.outcome === "pass"), "Partial drafts cannot be published.");
    requireCondition(report.draftProof.slug === report.slug && ["routerCommit","codexVersion","windowsAppVersion","executionSurface","windowsSandbox","sandboxPolicy","approvalPolicy"].every(key => report.draftProof[key] === evidence[key]), "Reviewed proof and run identities must agree.");
    report.proof = {...report.draftProof,status:"accepted",evidence:path.relative(sourceRoot,evidencePath).replaceAll("\\","/")}; delete report.draftProof;
  }
  const stage = path.join(sourceRoot,"generated",`certification-publication-${randomUUID()}`);
  try {
    writeProofs(evidence,stage,evidencePath,{linkApplicationsRoot:path.join(sourceRoot,"v2_agent"),sourceRoot});
    validateV2AgentApplications(stage,{models:routes});
    const publications = evidence.reports.flatMap(report => ["proof.json","proof.md"].map(name => ({from:path.join(stage,report.slug,name),to:path.join(sourceRoot,"v2_agent",report.slug,name)})));
    const previous = publications.map(file => existsSync(file.to) ? readFileSync(file.to) : undefined);
    let historyWritten = false;
    try {
      mkdirSync(history,{recursive:true});
      writeFileSync(evidencePath,`${JSON.stringify(evidence,null,2)}\n`,{flag:"wx"}); historyWritten = true;
      for (const file of publications) { mkdirSync(path.dirname(file.to),{recursive:true}); copy(file.from,file.to); }
    } catch (error) {
      for (let index = 0; index < publications.length; index++) {
        if (previous[index]) writeFileSync(publications[index].to,previous[index]); else rmSync(publications[index].to,{force:true});
      }
      if (historyWritten) rmSync(evidencePath); throw error;
    }
    return {status:"accepted",routes:routes.map(route => route.slug),evidence:evidencePath};
  } finally { rmSync(stage,{recursive:true,force:true}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCertificationRunnerArguments(process.argv.slice(2));
    const result = options.command === "run" ? await runCertification(options) : publishCertificationDraft(json(options.draft),options.evidence);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof CertificationRunnerError ? error.message : `Certification could not be verified${error.code ? ` (${error.code})` : ""}; inspect the local artifacts.`); process.exitCode = 1;
  }
}
