// Runs the five live checks from v2_agent/README.md against one route.
//
// The router already refuses to promote a route on anything less than all five
// (see `verifiedForRoute`), so this module's only job is to produce an honest
// result for each one. Every check is evidence a reviewer would reproduce by
// hand: two cheap HTTP turns, then the delegation itself through a real Codex
// parent, then a same-thread follow-up to that same child.
//
// The decision logic is deliberately separated from the live calls so the part
// that decides whether a route is promotable can be tested without spending a
// provider's quota.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routedAgentDefinition } from "./codex-agent-catalog.mjs";
import { spawnableCommand } from "./codex-binary.mjs";
import { VERIFICATION_CHECKS } from "./subagent-proofs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_CALL_MODES = new Set(["forced", "auto"]);

export const CHECK_LABELS = Object.freeze({
  streaming: "streamed reply",
  toolCall: "tool call",
  encryptedRelay: "subagent delegation",
  markerReturn: "subagent reply",
  sameThreadFollowUp: "second subagent turn",
});

function pending() {
  const checks = {};
  for (const name of VERIFICATION_CHECKS) checks[name] = { outcome: "pending" };
  return checks;
}

function pass(status, at = new Date().toISOString()) {
  return { outcome: "pass", ...(status ? { status } : {}), observedAt: at };
}

function fail(detail, at = new Date().toISOString()) {
  return { outcome: "fail", ...(detail ? { detail: String(detail).slice(0, 300) } : {}), observedAt: at };
}

// These answer about the account or the moment, never about the route: rate
// limits, exhausted quota and outages clear on their own, and a missing
// credential or plan entitlement clears when the operator fixes it. Recording
// them as a refusal tells the operator their model cannot host subagents when
// all that happened was a 429.
const STATUS_ABOUT_THE_ACCOUNT = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

function deferred(status, detail, at = new Date().toISOString()) {
  return {
    outcome: "deferred",
    ...(status ? { status } : {}),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    observedAt: at,
  };
}

function httpOutcome(status, detail) {
  return STATUS_ABOUT_THE_ACCOUNT.has(status) ? deferred(status, detail) : fail(detail);
}

export function runDeferred(checks) {
  return VERIFICATION_CHECKS.some((name) => checks?.[name]?.outcome === "deferred");
}

// The first check that did not pass, in reviewer order. A run stops there, so
// this is also the reason the route was not promoted.
export function firstFailure(checks) {
  const name = VERIFICATION_CHECKS.find((check) => checks?.[check]?.outcome !== "pass");
  if (!name) return undefined;
  return { check: name, label: CHECK_LABELS[name], detail: checks?.[name]?.detail };
}

export function checksComplete(checks) {
  return VERIFICATION_CHECKS.every((name) => checks?.[name]?.outcome === "pass");
}

// Copy only the bounded result metadata into the checked-in application. The
// live run handles prompts, response bodies and credentials; none of those
// belong in durable evidence. Existing route identity, sources, and exact
// provider/runtime bindings are preserved for review rather than inferred from
// the current machine.
export function recordApplicationEvidence(
  slug,
  { checks, routerVersion, at = new Date().toISOString() },
  { applicationsRoot = path.join(REPO_ROOT, "v2_agent") } = {},
) {
  const parts = String(slug || "").split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[a-z0-9][a-z0-9._-]*$/i.test(part))) {
    throw new Error(`Invalid v2 application slug: ${slug}`);
  }
  if (!checksComplete(checks)) {
    throw new Error(`Refusing to record incomplete v2 evidence for ${slug}`);
  }
  if (!TOOL_CALL_MODES.has(checks.toolCall.mode)) {
    throw new Error(`Refusing to record v2 evidence without a known tool-call mode for ${slug}`);
  }
  const applicationPath = path.join(applicationsRoot, ...parts, "proof.json");
  if (!existsSync(applicationPath)) {
    throw new Error(`Missing v2 application for ${slug}: ${applicationPath}`);
  }
  const existing = JSON.parse(readFileSync(applicationPath, "utf8"));
  const recordedChecks = {};
  for (const name of VERIFICATION_CHECKS) {
    const check = checks[name];
    recordedChecks[name] = {
      outcome: "pass",
      ...(Number.isInteger(check.status) ? { status: check.status } : {}),
      ...(check.completion === "codex-task-complete" ? { completion: check.completion } : {}),
      ...(name === "toolCall" ? { mode: check.mode } : {}),
      observedAt: check.observedAt,
    };
  }
  const application = {
    ...existing,
    status: "draft",
    testedAt: at,
    routerVersion,
    checks: recordedChecks,
  };
  writeFileSync(applicationPath, `${JSON.stringify(application, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path.relative(REPO_ROOT, applicationPath).replaceAll(path.sep, "/");
}

// A marker is generated per run and never reused. A route that echoes a
// previous run's marker, or that a cached transcript happens to contain,
// must not be able to pass on that.
export function newMarker(prefix = "CRV") {
  return `${prefix}-${randomBytes(9).toString("hex").toUpperCase()}`;
}

// What the JSONL event stream has to show for the delegation checks to hold:
// a child actually started on the agent this route owns, and the marker came
// back. A marker in the parent's own text proves nothing -- the parent can
// read the marker out of its own prompt -- so it only counts inside a child
// event, or after a child on that agent has started.
export function readDelegation(events, { agentName, marker }) {
  let childStarted = false;
  let markerReturned = false;
  const callIds = new Set();
  let anonymousCallStarted = false;
  for (const event of Array.isArray(events) ? events : []) {
    const item = event?.item;
    if (event?.type === "item.started" && item?.type === "agent_call" && item.agent_type === agentName) {
      childStarted = true;
      if (item.id) callIds.add(String(item.id));
      else anonymousCallStarted = true;
      continue;
    }
    if (event?.type !== "item.completed" || item?.type !== "agent_call") continue;
    const belongsToChild =
      item.agent_type === agentName ||
      (item.id && callIds.has(String(item.id))) ||
      (!item.id && anonymousCallStarted);
    if (belongsToChild && marker && JSON.stringify(item.output ?? "").includes(marker)) {
      markerReturned = true;
    }
  }
  return { childStarted, markerReturned };
}

export function completedTurn(events) {
  return Array.isArray(events) && events.some((event) => event?.type === "turn.completed");
}

export function startedThreadId(events) {
  const started = (Array.isArray(events) ? events : []).find(
    (event) => event?.type === "thread.started" && typeof event.thread_id === "string",
  );
  return started?.thread_id;
}

// Codex refuses to spawn a non-OpenAI child while the parent is signed in with
// a ChatGPT account, and says so in the parent's own message. That is a
// property of the harness and the account, not of the route -- branding the
// route "cannot run subagents" for it is the same wrong verdict as a 429.
const ACCOUNT_REFUSES_ROUTE =
  /not supported when using Codex with a ChatGPT account|isn.t supported with the current ChatGPT account/i;

export function accountRefusal(events) {
  for (const event of Array.isArray(events) ? events : []) {
    const text = typeof event === "string" ? event : JSON.stringify(event ?? "");
    if (ACCOUNT_REFUSES_ROUTE.test(text)) {
      return "Codex will not spawn this route as a subagent while signed in with a ChatGPT account.";
    }
  }
  return undefined;
}

export function parseEventLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
}

// Responses providers may return one JSON document or an SSE event stream.
// Switchyard preserves Codex's streaming transport even for this small probe,
// so looking only for payload.output silently discards a valid function call.
export function responseOutputItems(body) {
  const items = [];
  const collect = (payload) => {
    if (Array.isArray(payload?.output)) items.push(...payload.output);
    if (Array.isArray(payload?.response?.output)) items.push(...payload.response.output);
    if (payload?.item && typeof payload.item === "object") items.push(payload.item);
  };
  try {
    collect(JSON.parse(String(body || "")));
    return items;
  } catch {
    // Fall through to the event stream parser.
  }
  for (const line of String(body || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      collect(JSON.parse(data));
    } catch {
      // A malformed or non-JSON event cannot contain a Responses output item.
    }
  }
  return items;
}

export function completedResponseWithText(body) {
  for (const line of String(body || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event?.type !== "response.completed") continue;
      const output = Array.isArray(event.response?.output) ? event.response.output : [];
      return output.some((item) =>
        item?.type === "message" && Array.isArray(item.content) &&
        item.content.some((part) => part?.type === "output_text" && String(part.text || "").length > 0),
      );
    } catch {
      // Ignore malformed event lines.
    }
  }
  return false;
}

function runCodex(args, { codexBin, codexHome, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const target = spawnableCommand(codexBin, args);
    // CodeQL conflates spawnableCommand's direct-exec and escaped Windows-batch
    // return shapes across unrelated callers. The helper rejects illegal batch
    // paths and escapes every cmd.exe metacharacter before this spawn.
    // codeql[js/shell-command-injection-from-environment]
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHome, MODEL_ROUTER_TARGET: "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

// `--ignore-user-config` means the run starts with no providers at all, so the
// child's `model_provider = "codex-router"` has to be declared here or no child
// can ever start -- which is what "no child ran on this route" was really
// reporting, for every route, regardless of the route.
function routerConfigArgs({ baseUrl, catalogPath }) {
  const args = [
    "--config",
    'model_providers.codex-router.name="Codex Router"',
    "--config",
    `model_providers.codex-router.base_url=${JSON.stringify(baseUrl)}`,
    "--config",
    'model_providers.codex-router.wire_api="responses"',
    "--config",
    "model_providers.codex-router.requires_openai_auth=true",
    "--config",
    "model_providers.codex-router.supports_websockets=false",
  ];
  if (catalogPath) args.push("--config", `model_catalog_json=${JSON.stringify(catalogPath)}`);
  return args;
}

function execArgs({ model, prompt, cwd, extra = [] }) {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "--model",
    model,
    "--config",
    "disable_response_storage=true",
    ...extra,
    "--cd",
    cwd,
    prompt,
  ];
}

// Checks 1-2. These run against the router's own authenticated endpoint rather
// than through Codex: a forced tool call with asserted arguments is the point
// of the check, and driving that through an agent turn would test the agent's
// judgement instead of the route's tool handling.
async function runHttpChecks({ slug, baseUrl, secret, timeoutMs }) {
  const results = {};
  // The caller endpoint speaks the Responses API and takes the caller key as a
  // bearer. `chat/completions` is not served here at all, so calling it
  // reported a 404 as though the route had failed the check.
  const url = `${baseUrl}/responses`;
  const headers = {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: slug,
        input: [{
          role: "user",
          content: [{ type: "input_text", text: "Reply with the single word: ready" }],
        }],
        stream: true,
        max_output_tokens: 64,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    results.streaming = response.ok && completedResponseWithText(text)
      ? pass(response.status)
      : httpOutcome(response.status, `streamed turn did not complete with text (HTTP ${response.status})`);
  } catch (error) {
    // A request that never got an answer -- an abort, a timeout, a socket the
    // router closed while restarting -- proved nothing about the route. Only a
    // reply the provider actually sent can refuse one.
    results.streaming = deferred(undefined, error?.message || "the streamed turn got no answer");
  }
  if (results.streaming.outcome !== "pass") return results;

  // Forced first, because a forced call is the strongest evidence and what the
  // application asks for. But a reasoning route can reject the forcing mode
  // itself -- "Thinking mode does not support this tool_choice" -- while
  // calling the tool perfectly well when simply offered it. Codex does not
  // force tool_choice in ordinary use, so refusing the route over the forcing
  // mode would fail it for something it is never asked to do.
  const toolProbe = async (choice) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: slug,
        input: [{
          role: "user",
          content: [{
            type: "input_text",
            text: 'Call codex_router_probe with token "ok". Use the tool; do not answer in prose.',
          }],
        }],
        max_output_tokens: 512,
        tools: [
          {
            type: "function",
            name: "codex_router_probe",
            description: "Return the supplied token.",
            parameters: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: choice,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const responseBody = await response.text();
    const calls = responseOutputItems(responseBody)
      .filter((item) => item?.type === "function_call" && item?.name === "codex_router_probe");
    const call = calls.find((candidate) => {
      try {
        return typeof JSON.parse(candidate.arguments ?? "").token === "string";
      } catch {
        return false;
      }
    });
    return {
      status: response.status,
      ok: response.ok && Boolean(call),
      sawCall: calls.length > 0,
      detail: "",
    };
  };

  try {
    const forced = await toolProbe({ type: "function", name: "codex_router_probe" });
    if (forced.ok) {
      results.toolCall = { ...pass(forced.status), mode: "forced" };
    } else if (STATUS_ABOUT_THE_ACCOUNT.has(forced.status)) {
      results.toolCall = deferred(forced.status, forced.detail || `forced tool call returned HTTP ${forced.status}`);
    } else {
      const offered = await toolProbe("auto");
      if (offered.ok) {
        results.toolCall = { ...pass(offered.status), mode: "auto" };
      } else if (STATUS_ABOUT_THE_ACCOUNT.has(offered.status)) {
        results.toolCall = deferred(offered.status, offered.detail || `tool call returned HTTP ${offered.status}`);
      } else {
        results.toolCall = fail(
          offered.sawCall
            ? "the tool call did not return valid JSON arguments"
            : offered.detail || `no tool call in the reply (HTTP ${offered.status})`,
        );
      }
    }
  } catch (error) {
    results.toolCall = deferred(undefined, error?.message || "the forced tool call got no answer");
  }
  return results;
}

// Checks 3-5. A native parent is asked to delegate to the agent this route
// owns; the child has to return a marker only this run knows, and then a
// second marker on a follow-up in the same session.
async function runDelegationChecks({
  slug,
  parentModel,
  codexBin,
  codexHome,
  baseUrl,
  catalogPath,
  workDir,
  timeoutMs,
}) {
  const results = {};
  const definition = routedAgentDefinition({ slug, displayName: slug });
  // The parent is a native model signing in with this machine's ChatGPT
  // session, so the run has to use the real CODEX_HOME. A throwaway home has
  // no credentials, and an unauthenticated parent cannot delegate anything.
  const agentsDir = path.join(codexHome, "agents");
  const agentFile = path.join(agentsDir, definition.fileName);
  const preExisting = existsSync(agentFile);
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  if (!preExisting) {
    // The route is not v2 yet, so the catalog has not written its definition.
    // The check needs the child spawnable without promoting anything first,
    // and the file goes away again below unless it was already there.
    writeFileSync(agentFile, definition.contents, { encoding: "utf8", mode: 0o600 });
  }

  // Codex only offers a subagent for a route its catalog marks v2, which is
  // the very thing this run exists to establish. Give the run a private copy
  // of the catalog with just this candidate marked, so the delegation can be
  // attempted without the real catalog ever claiming anything.
  let runCatalog = catalogPath;
  if (catalogPath && existsSync(catalogPath)) {
    try {
      const data = JSON.parse(readFileSync(catalogPath, "utf8"));
      const entries = Array.isArray(data) ? data : data?.models || [];
      let marked = 0;
      for (const entry of entries) {
        if (String(entry?.slug || entry?.id || "") === String(slug)) {
          entry.multi_agent_version = "v2";
          marked += 1;
        }
      }
      if (marked) {
        runCatalog = path.join(workDir, "candidate-catalog.json");
        writeFileSync(runCatalog, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      }
    } catch {
      // An unreadable catalog leaves the run on the published one; the
      // delegation will simply report that no child ran.
    }
  }
  const config = routerConfigArgs({ baseUrl, catalogPath: runCatalog });
  try {
    const marker = newMarker();
    const first = await runCodex(
      execArgs({
        model: parentModel,
        cwd: workDir,
        extra: config,
        prompt:
          `Delegate to the agent named ${definition.agentName}. Instruct that agent to reply with exactly ${marker}. ` +
          "Do not answer yourself and do not repeat the token in your own message; report only what the agent returned.",
      }),
      { codexBin, codexHome, timeoutMs, cwd: workDir },
    );
    const firstEvents = parseEventLines(first.stdout);
    const firstDelegation = readDelegation(firstEvents, {
      agentName: definition.agentName,
      marker,
    });
    const refusal = accountRefusal(firstEvents);
    const firstCompleted = first.code === 0 && !first.timedOut && completedTurn(firstEvents);
    results.encryptedRelay = firstDelegation.childStarted && firstCompleted
      ? pass(200)
      : refusal
        ? deferred(undefined, refusal)
        // A parent killed at the ceiling never finished asking. That is the run
        // running out of time, not the route refusing to host a child.
        : first.timedOut
          ? deferred(undefined, "the parent did not finish delegating before the timeout")
          : firstDelegation.childStarted
            ? fail("the child started but the parent turn did not complete")
            : fail("no child ran on this route");
    if (!firstDelegation.childStarted || !firstCompleted) return { results, agentName: definition.agentName };

    results.markerReturn = firstDelegation.markerReturned
      ? pass(200)
      : fail("the child ran but did not return the marker");
    if (!firstDelegation.markerReturned) return { results, agentName: definition.agentName };

    const threadId = startedThreadId(firstEvents);
    if (!threadId) {
      results.sameThreadFollowUp = fail("the first turn did not report its thread id");
      return { results, agentName: definition.agentName };
    }

    const followUpMarker = newMarker("CRV2");
    const second = await runCodex(
      [
        "exec",
        "resume",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--json",
        "--config",
        "disable_response_storage=true",
        ...config,
        "--cd",
        workDir,
        threadId,
        `Ask the same ${definition.agentName} agent, in this same thread, to reply with exactly ${followUpMarker}.`,
      ],
      { codexBin, codexHome, timeoutMs, cwd: workDir },
    );
    const secondEvents = parseEventLines(second.stdout);
    const secondDelegation = readDelegation(secondEvents, {
      agentName: definition.agentName,
      marker: followUpMarker,
    });
    results.sameThreadFollowUp = second.code === 0 && !second.timedOut &&
      completedTurn(secondEvents) && secondDelegation.markerReturned
      ? pass(200)
      : fail("the child did not answer a second turn in the same thread");
    return { results, agentName: definition.agentName };
  } finally {
    // Leave the agents directory exactly as it was found. A definition left
    // behind would keep an uncertified route spawnable by name.
    if (!preExisting) rmSync(agentFile, { force: true });
  }
}

// One route, all five checks, stopping at the first failure so a route that
// cannot stream never spends quota on a delegation.
export async function verifySubagentRoute(
  slug,
  {
    baseUrl,
    secret,
    codexBin,
    codexHome,
    parentModel = "gpt-5.6-sol",
    catalogPath,
    routerVersion,
    timeoutMs = 120_000,
  } = {},
) {
  const checks = pending();
  const started = Date.now();
  const http = await runHttpChecks({ slug, baseUrl, secret, timeoutMs });
  Object.assign(checks, http);
  if (checks.streaming.outcome !== "pass" || checks.toolCall.outcome !== "pass") {
    return { slug, checks, ok: false, routerVersion, durationMs: Date.now() - started };
  }

  // Only the working directory is disposable. The Codex home stays real so the
  // parent can authenticate.
  const workDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-certify-"));
  try {
    const { results } = await runDelegationChecks({
      slug,
      parentModel,
      codexBin,
      codexHome,
      baseUrl,
      catalogPath,
      workDir,
      timeoutMs,
    });
    Object.assign(checks, results);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return {
    slug,
    checks,
    ok: checksComplete(checks),
    routerVersion,
    durationMs: Date.now() - started,
  };
}
