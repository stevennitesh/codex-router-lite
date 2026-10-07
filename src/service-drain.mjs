import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERNAL_SECRET_PATH, PORTS, loopback } from "./paths.mjs";

const SERVICE = "codex-router";

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

function transportCodes(error) {
  const result = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (typeof value.code === "string") result.push(value.code);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return result;
}

function refused(error) {
  const codes = transportCodes(error);
  return codes.length > 0 && codes.every((code) => code === "ECONNREFUSED");
}

async function jsonResponse(response) {
  const value = await response.json().catch(() => undefined);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function prepareRouterServiceMutation({
  force = false,
  timeoutMs = 30_000,
  waitForIdleMs = 0,
  fetchImpl = fetch,
  internalKey,
  baseUrl = loopback(PORTS.router, ""),
} = {}) {
  if (!Number.isSafeInteger(waitForIdleMs) || waitForIdleMs < 0 || waitForIdleMs > 300_000) {
    throw new Error("Idle wait must be an integer between 0 and 300000 milliseconds.");
  }
  let live;
  try {
    live = await fetchImpl(`${baseUrl}/live`, {
      signal: AbortSignal.timeout(3_000),
      redirect: "error",
    });
  } catch (error) {
    if (refused(error)) return { status: "offline" };
    throw new Error(`Router liveness is unknown; refusing service mutation: ${errorMessage(error)}.`);
  }
  const identity = await jsonResponse(live);
  if (!live.ok || identity.service !== SERVICE) {
    throw new Error("The Router port did not prove the owned codex-router service identity; refusing service mutation.");
  }
  const supportsDrain = Array.isArray(identity.capabilities) && identity.capabilities.includes("drain-v1");
  if (!supportsDrain) {
    if (!force) {
      const error = new Error(
        "The running Router predates authenticated drain. Normal replacement was deferred; settle active work and retry with the explicit service-force option.",
      );
      error.code = "ERR_ROUTER_DRAIN_UNSUPPORTED";
      throw error;
    }
    return { status: "legacy-force", service: SERVICE };
  }
  internalKey ??= readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
  if (typeof internalKey !== "string" || !internalKey) {
    throw new Error("The internal service capability is unavailable; refusing service mutation.");
  }
  // Let brief activity settle without closing admission or repeating the
  // deployment preflight. The authenticated drain below still owns the race
  // between the final idle observation and service replacement.
  if (waitForIdleMs > 0 && !force) {
    const deadline = performance.now() + waitForIdleMs;
    let status;
    while (true) {
      if (status && performance.now() >= deadline) {
        const error = new Error(
          `Router did not become idle within ${waitForIdleMs} milliseconds (${status.activeRequests} active requests, ${status.workflows} Switchyard workflows, indeterminate workflow: ${status.indeterminateWorkflow}); admission was left open and the running generation was left unchanged.`,
        );
        error.code = "ERR_ROUTER_DRAIN_DEFERRED";
        throw error;
      }
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      let statusResponse;
      try {
        statusResponse = await fetchImpl(`${baseUrl}/internal/lifecycle`, {
          headers: { authorization: `Bearer ${internalKey}` },
          signal: AbortSignal.timeout(Math.min(3_000, remaining)),
          redirect: "error",
        });
      } catch (error) {
        throw new Error(`Router idle status could not be verified; refusing service mutation: ${errorMessage(error)}.`);
      }
      status = await jsonResponse(statusResponse);
      if (!statusResponse.ok || status.capability !== "drain-v1"
        || !Number.isSafeInteger(status.activeRequests) || status.activeRequests < 0
        || !Number.isSafeInteger(status.workflows) || status.workflows < 0
        || typeof status.indeterminateWorkflow !== "boolean") {
        throw new Error(`Router idle status is unverified (HTTP ${statusResponse.status}); refusing service mutation.`);
      }
      if (status.state !== "open") {
        const error = new Error("Router admission is already draining or closed; refusing another service mutation.");
        error.code = "ERR_ROUTER_DRAIN_DEFERRED";
        throw error;
      }
      if (status.activeRequests === 0 && status.workflows === 0 && !status.indeterminateWorkflow) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(250, deadline - performance.now()))));
    }
  }
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/internal/lifecycle/drain`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${internalKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ timeout_ms: timeoutMs, force }),
      signal: AbortSignal.timeout(Math.max(3_000, timeoutMs + 2_000)),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`Authenticated Router drain failed; refusing service mutation: ${errorMessage(error)}.`);
  }
  const result = await jsonResponse(response);
  if (response.status === 401) {
    throw new Error("The running Router rejected the internal service capability; refusing service mutation.");
  }
  if (response.ok && ["drained", "forced"].includes(result.status)) return result;
  if (response.status === 409 && result.status === "deferred") {
    const error = new Error(
      `Router replacement was deferred (${result.reason || "active work"}); admission was restored and the running generation was left unchanged.`,
    );
    error.code = "ERR_ROUTER_DRAIN_DEFERRED";
    throw error;
  }
  throw new Error(`Router drain returned an invalid response (HTTP ${response.status}); refusing service mutation.`);
}

export async function resumeRouterAdmission({
  fetchImpl = fetch,
  internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim(),
  baseUrl = loopback(PORTS.router, ""),
} = {}) {
  const response = await fetchImpl(`${baseUrl}/internal/lifecycle/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${internalKey}` },
    signal: AbortSignal.timeout(3_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Router admission resume failed with HTTP ${response.status}.`);
  return jsonResponse(response);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    const waitIndex = process.argv.indexOf("--wait-for-idle-ms");
    const result = command === "prepare"
      ? await prepareRouterServiceMutation({
        force: process.argv.includes("--force-service-replacement"),
        waitForIdleMs: waitIndex === -1 ? 0 : Number(process.argv[waitIndex + 1]),
      })
      : command === "resume"
        ? await resumeRouterAdmission()
        : undefined;
    if (!result) throw new Error("Usage: service-drain prepare [--force-service-replacement] [--wait-for-idle-ms N] [--json-errors]|resume");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (process.argv.includes("--json-errors")) {
      process.stdout.write(`${JSON.stringify({ error: { code: error?.code, message: errorMessage(error) } })}\n`);
    } else {
      console.error(errorMessage(error));
    }
    process.exitCode = 1;
  }
}
