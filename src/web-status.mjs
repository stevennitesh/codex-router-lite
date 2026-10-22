import { readFileSync } from "node:fs";

import { webBridgeConfigurationStatus, WEB_BRIDGE_TUNNEL_KEY_PATH } from "./chatgpt-web.mjs";
import { readControlHealth } from "./control-health.mjs";
import { fileProbeErrorReason, probeRegularFile } from "./file-probe.mjs";
import { readSubagentProtocol } from "./multi-agent-state.mjs";
import { webStopAdapterStatus } from "./web-stop-adapter-install.mjs";

export function webTunnelKeyStatus({ keyPath = WEB_BRIDGE_TUNNEL_KEY_PATH, probe = probeRegularFile, read = readFileSync } = {}) {
  const observed = probe(keyPath);
  if (observed.status === "missing") return { configured: false, fileStatus: "missing" };
  if (observed.status !== "present") throw new Error(`Cannot read the protected ChatGPT Web tunnel key (${observed.status}).`);
  let secret;
  try { secret = read(keyPath, "utf8").trim(); }
  catch (error) { throw new Error(`Cannot read the protected ChatGPT Web tunnel key (${fileProbeErrorReason(error)}).`); }
  if (/[\u0000-\u001f\u007f]/u.test(secret)) throw new Error("The protected ChatGPT Web tunnel key contains invalid control characters.");
  return { configured: Boolean(secret), fileStatus: secret ? "present" : "empty" };
}

function routerStatus(health) {
  const httpStatus = Number.isInteger(health.status) ? health.status : 0;
  const degraded = Array.isArray(health.degraded) ? health.degraded.filter(name => ["api", "gateway", "switchyard"].includes(name)) : [];
  if (httpStatus === 0) return { status: "unavailable", reachable: false, httpStatus,
    detail: health.error === "The local router caller key is unavailable." ? health.error
      : health.error === "Health check timed out." ? health.error : "Router is unreachable." };
  if (health.service !== "codex-router" || health.router !== "ready" || !Array.isArray(health.degraded)) {
    return { status: "unknown", reachable: true, httpStatus, detail: "The protected health response did not establish Router readiness." };
  }
  return { status: health.ok && httpStatus === 200 && health.degraded.length === 0 ? "ready" : "degraded",
    reachable: true, httpStatus, degraded };
}

// Only the explicit maintenance command performs these observations. Catalog and
// configuration callers keep the synchronous, configuration-only bridge status.
export async function readWebMaintenanceStatus({
  readConfiguration = webBridgeConfigurationStatus,
  readProtocol = readSubagentProtocol,
  readKeyStatus = webTunnelKeyStatus,
  readAdapterStatus = webStopAdapterStatus,
  readRuntimePlan = async () => (await import("./web-runtime-refresh.mjs")).refreshWebRuntime(),
  readHealth = readControlHealth,
} = {}) {
  let configuration, subagentProtocol, tunnelKey, stopAdapter;
  try { configuration = { ...readConfiguration(), configurationStatus: "ok" }; }
  catch { configuration = { configurationStatus: "unavailable", enabled: null,
    detail: "Cannot read the saved Web configuration; inspect it before reconfiguring." }; }
  try { subagentProtocol = readProtocol(); }
  catch { subagentProtocol = "unknown"; }
  try { tunnelKey = readKeyStatus(); }
  catch { tunnelKey = { configured: null, fileStatus: "unavailable", detail: "Cannot read a valid protected tunnel key; its value is never reported." }; }
  // The shared refresh planner validates the current official candidate. Avoid
  // separately verifying the obsolete external runtime before that same work.
  try { stopAdapter = readAdapterStatus({ inspectRuntime: configuration.enabled !== true }); }
  catch { stopAdapter = { installed: null, state: "unknown", hookDefinitionOwned: "unknown", appLoaded: "unknown", hookTrusted: "unknown",
    restartRequired: "unknown", trustRequired: "unknown", detail: "Cannot verify local adapter ownership; inspect adapter-status before changing the installation." }; }
  let runtimeUpdate = { status: "not-configured", ready: false };
  if (configuration.configurationStatus !== "ok") runtimeUpdate = { status: "unavailable", ready: false };
  else if (stopAdapter.recoveryRequired || stopAdapter.conflicts?.length) runtimeUpdate = { status: "ownership-conflict", ready: false };
  else if (configuration.enabled === true) {
    if (["absent", "removed"].includes(stopAdapter.state)) runtimeUpdate = { status: "setup-required", ready: false };
    else if (stopAdapter.state === "installed" && stopAdapter.ownershipVerified === true) {
      try {
        const plan = await readRuntimePlan();
        if (plan.ready !== true || typeof plan.changed !== "boolean") throw new Error("Unconfirmed runtime plan.");
        runtimeUpdate = { status: plan.changed ? "refresh-required" : "current", ready: true,
          routerRestartRequired: plan.routerRestartRequired, codexRestartRequired: plan.codexRestartRequired };
        if (!plan.changed) stopAdapter = { ...stopAdapter, installed: true, runtimeStatus: "current", runtimeIssues: [] };
      } catch (error) {
        runtimeUpdate = { status: error.code === "ERR_WEB_RUNTIME_ANCHORS" ? "manifest-required" : "unavailable", ready: false };
      }
    } else runtimeUpdate = { status: "unavailable", ready: false };
  }
  const router = routerStatus(await readHealth({ timeoutMs: 3_000,
    fetchImpl: (url, options) => globalThis.fetch(url, { ...options, redirect: "error" }) }));
  const next = [];
  if (configuration.enabled === false) next.push("Run model-router.ps1 codex web browser <safe-config-json-file> when you want to enable Web routes.");
  if (configuration.enabled === true && tunnelKey.configured === false) next.push("Run model-router.ps1 codex web tunnel-key set to save the tunnel runtime key at the hidden prompt.");
  if (configuration.enabled === true && ["absent", "removed"].includes(stopAdapter.state)) next.push("For immediate Stop on future normal launches, install a reviewed adapter manifest with model-router.ps1 codex web stop install-adapter <adapter-manifest-json>.");
  if (runtimeUpdate.status === "refresh-required") next.push("Run model-router.ps1 codex web refresh-runtime --apply to refresh the owned adapter and browser together, then fully quit and reopen Codex when requested.");
  if (runtimeUpdate.status === "manifest-required") next.push("Current official runtime anchors are missing or ambiguous. Run model-router.ps1 codex web refresh-runtime --manifest <reviewed-manifest-json> to validate an explicit replacement before applying it.");
  if (runtimeUpdate.status === "unavailable" && configuration.enabled === true) next.push("Run model-router.ps1 codex web refresh-runtime to inspect the runtime validation failure before changing any selection.");
  if (router.status === "unavailable" || router.status === "degraded" || router.status === "unknown") next.push("Run model-router.ps1 codex doctor to diagnose the observed Router health condition.");
  if (stopAdapter.recoveryRequired || stopAdapter.conflicts?.length || stopAdapter.state === "unknown") next.push("Inspect model-router.ps1 codex web stop adapter-status and resolve the local ownership condition before installing or rolling back.");
  return { ...configuration, subagentProtocol, tunnelKey, router, stopAdapter, runtimeUpdate,
    readiness: {
      tunnel: configuration.enabled === false ? "disabled" : "unknown",
      browserSession: "unknown", nativeTools: "unknown", immediateStop: "unknown",
      detail: "Router health does not expose Web tunnel state. Sign-in, selected model/connector, current app adapter loading, hook trust and actual Stop require verification in Codex.",
    }, next };
}
