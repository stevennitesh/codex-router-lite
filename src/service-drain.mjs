import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERNAL_SECRET_PATH, PORTS, loopback } from "./paths.mjs";
import { conclusivelyRefused } from "./transport-error-graph.mjs";

const SERVICE = "codex-router";

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

async function jsonResponse(response) {
  const value = await response.json().catch(() => undefined);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export async function prepareRouterServiceMutation({
  force = false,
  timeoutMs = 30_000,
  fetchImpl = fetch,
  internalKey,
  baseUrl = loopback(PORTS.router, ""),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("Drain timeout must be an integer between 1 and 300000 milliseconds.");
  }
  let live;
  try {
    live = await fetchImpl(`${baseUrl}/live`, {
      signal: AbortSignal.timeout(3_000),
      redirect: "error",
    });
  } catch (error) {
    if (conclusivelyRefused(error)) return { status: "offline" };
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
        "This older Router cannot wait for running requests before stopping. It was left running. Stopping or updating it requires explicit approval to interrupt work with --force-service-replacement.",
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
      `Router was not stopped or changed because work is still pending (reason: ${result.reason || "active work"}; running requests: ${result.activeRequests ?? "unknown"}, unfinished Switchyard workflows: ${result.workflows ?? "unknown"}). It is accepting new requests again. Wait for the work to finish, or explicitly approve interrupting it with --force-service-replacement.`,
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
    const timeoutIndex = process.argv.indexOf("--timeout-ms");
    const result = command === "prepare"
      ? await prepareRouterServiceMutation({
        force: process.argv.includes("--force-service-replacement"),
        timeoutMs: timeoutIndex === -1 ? 30_000 : Number(process.argv[timeoutIndex + 1]),
      })
      : command === "resume"
        ? await resumeRouterAdmission()
        : undefined;
    if (!result) throw new Error("Usage: service-drain prepare [--force-service-replacement] [--timeout-ms N] [--json-errors]|resume");
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
