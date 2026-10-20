import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import { createPrivateFile } from "./file-security.mjs";

const startupMs = 60_000;
const shutdownMs = 5_000;
const environmentNames = new Set([
  "systemroot", "windir", "path", "pathext", "temp", "tmp", "userprofile",
  "homedrive", "homepath", "appdata", "localappdata", "comspec", "home",
]);
const messages = {
  web_tunnel_invalid_config: "ChatGPT Web tunnel configuration is invalid.",
  web_tunnel_start_failed: "ChatGPT Web tunnel could not start.",
  web_tunnel_exited: "ChatGPT Web tunnel exited.",
  web_tunnel_not_ready: "ChatGPT Web tunnel did not become ready.",
  web_tunnel_auth_rejected: "ChatGPT Web tunnel authentication was rejected. Replace its protected runtime key or grant its principal Tunnels Read and Use, then restart Router.",
  web_tunnel_cancelled: "ChatGPT Web tunnel was stopped.",
  web_tunnel_stop_failed: "ChatGPT Web tunnel shutdown could not be verified.",
  web_tunnel_cleanup_failed: "ChatGPT Web tunnel private state could not be removed.",
};
const failure = code => Object.assign(new Error(messages[code]), { code });

function regularFile(file, maximum = Infinity) {
  const info = lstatSync(file);
  return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum;
}

function localUrl(value, { mcp = false } = {}) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) === 0
      || url.username || url.password || url.search || url.hash
      || !(mcp ? /^\/[A-Za-z0-9_-]{32,256}\/mcp$/u.test(url.pathname) : url.pathname === "/")) {
    throw failure("web_tunnel_invalid_config");
  }
  return url;
}

async function readPollHealth(response) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    return undefined;
  }
  const chunks = [];
  let bytes = 0;
  // Official v0.0.16 component health is bounded to 24 KiB. Keep the
  // passive snapshot local: never retain or expose arbitrary daemon details.
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 24 * 1024) throw failure("web_tunnel_not_ready");
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const failures = value?.details?.consecutive_failures;
  return value?.schema_version === 1 && value.component === "control-plane" && value.limited === false
    && Number.isSafeInteger(failures) && failures >= 0 ? value : undefined;
}

/** Own the official foreground tunnel daemon for the Router generation. */
export async function startWebTunnel({ executable, tunnelId, keyPath, serverUrl, stateDir, signal, spawnImpl = spawn } = {}) {
  try {
    if (![executable, keyPath, stateDir].every(value => typeof value === "string" && path.isAbsolute(value))
        || !/^tunnel_[A-Za-z0-9_-]{1,180}$/u.test(tunnelId ?? "")
        || !regularFile(executable) || !regularFile(keyPath, 8192)
        || typeof spawnImpl !== "function" || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw failure("web_tunnel_invalid_config");
    }
    localUrl(serverUrl, { mcp: true });
  } catch { throw failure("web_tunnel_invalid_config"); }
  if (signal?.aborted) throw failure("web_tunnel_cancelled");

  let directory, configFile, healthFile;
  const files = [];
  const cleanup = () => {
    let failed = false;
    for (const file of files) {
      try { unlinkSync(file); }
      catch (error) { if (error?.code !== "ENOENT") failed = true; }
    }
    if (directory) {
      try { rmdirSync(directory); }
      catch (error) { if (error?.code !== "ENOENT") failed = true; }
    }
    if (failed) throw failure("web_tunnel_cleanup_failed");
  };
  try {
    mkdirSync(stateDir, { recursive: true });
    directory = mkdtempSync(path.join(stateDir, "web-tunnel-"));
    configFile = path.join(directory, "tunnel.yaml");
    healthFile = path.join(directory, "health.url");
    // JSON strings are valid quoted YAML scalars, including Windows paths.
    // The actual key is read only by the official daemon from its protected file.
    const config = [
      "config_version: 1",
      "control_plane:",
      `  tunnel_id: ${JSON.stringify(tunnelId)}`,
      `  api_key: ${JSON.stringify(`file:${keyPath}`)}`,
      "mcp:",
      "  server_urls:",
      "    - channel: main",
      `      url: ${JSON.stringify(serverUrl)}`,
      "health:",
      '  listen_addr: "127.0.0.1:0"',
      `  url_file: ${JSON.stringify(healthFile)}`,
      "admin_ui:",
      "  open_browser: false",
      "log:",
      "  level: warn",
      "  format: json",
      "",
    ].join("\n");
    createPrivateFile(configFile, config);
    files.push(configFile);
    createPrivateFile(healthFile, "");
    files.push(healthFile);
  } catch {
    try { cleanup(); } catch { throw failure("web_tunnel_cleanup_failed"); }
    throw failure("web_tunnel_start_failed");
  }

  let child, childClosed = false, spawned = false, closing = false, stopped = false;
  let healthy = false, isReady = false, failureCode;
  let readySettled = false, resolveReady, rejectReady, resolveClosed, closePromise;
  let pollTimer, startupTimer, polling = false;
  const lifetime = new AbortController();
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The caller may await readiness after connecting its other generation owners.
  void ready.catch(() => {});
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const settleReady = error => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(startupTimer);
    if (error) rejectReady(error);
    else resolveReady();
  };
  const fail = code => {
    failureCode ??= code;
    healthy = false;
    isReady = false;
    settleReady(failure(code));
    void close().catch(() => {});
  };
  const abort = () => {
    settleReady(failure("web_tunnel_cancelled"));
    void close().catch(() => {});
  };

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    healthy = false;
    isReady = false;
    clearInterval(pollTimer);
    clearTimeout(startupTimer);
    lifetime.abort();
    signal?.removeEventListener("abort", abort);
    settleReady(failure("web_tunnel_cancelled"));
    closePromise = (async () => {
      if (child && !childClosed) {
        try { child.kill("SIGTERM"); } catch { /* Closure below remains the authority. */ }
        let forceTimer, deadline;
        try {
          forceTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3_000);
          await Promise.race([
            closed,
            new Promise((_, reject) => { deadline = setTimeout(() => reject(failure("web_tunnel_stop_failed")), shutdownMs); }),
          ]);
        } finally {
          clearTimeout(forceTimer);
          clearTimeout(deadline);
        }
      }
      cleanup();
      stopped = true;
    })().catch(error => {
      failureCode = error?.code === "web_tunnel_cleanup_failed" ? "web_tunnel_cleanup_failed" : "web_tunnel_stop_failed";
      throw failure(failureCode);
    });
    return closePromise;
  }

  async function pollHealth() {
    if (polling || closing || !spawned || childClosed) return;
    polling = true;
    try {
      if (!regularFile(healthFile, 2048)) throw failure("web_tunnel_not_ready");
      const base = localUrl(readFileSync(healthFile, "utf8").trim());
      const options = { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1500)]), redirect: "error", cache: "no-store" };
      const health = await fetch(new URL("/healthz", base), options);
      await health.body?.cancel();
      if (closing || childClosed) return;
      if (!health.ok) { healthy = false; isReady = false; return; }
      const result = await fetch(new URL("/readyz", base), { ...options, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1500)]) });
      await result.body?.cancel();
      if (closing || childClosed) return;
      if (!result.ok) { healthy = true; isReady = false; return; }
      // /readyz gates local startup only; it can pass while every hosted
      // poll is rejected. Require the daemon's own completed poll evidence.
      const poll = await readPollHealth(await fetch(new URL("/health/control-plane", base), {
        ...options, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1500)]),
      }));
      if (closing || childClosed) return;
      const details = poll?.details;
      if (poll?.status === "degraded" && details.consecutive_failures > 0
          && details.failure_category === "http_error" && [401, 403].includes(details.http_status)) {
        fail("web_tunnel_auth_rejected");
        return;
      }
      const successful = typeof details?.last_success === "string" ? Date.parse(details.last_success) : NaN;
      healthy = poll?.status === "ok" && details.consecutive_failures === 0
        && ["idle", "polling", "backpressured"].includes(poll.state) && Number.isFinite(successful) && successful > 0;
      isReady = healthy;
      if (isReady) settleReady();
    } catch {
      healthy = false;
      isReady = false;
    } finally { polling = false; }
  }

  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => environmentNames.has(name.toLowerCase())));
    child = spawnImpl(executable, ["run", "--config", configFile, "--admin-ui.log-buffer-events", "1"], {
      cwd: directory, env, windowsHide: true, shell: false,
      // Child diagnostics can contain local target capabilities or credential
      // errors. They never reach Router output or retained log buffers.
      stdio: "ignore",
    });
    child.once("spawn", () => { spawned = true; void pollHealth(); });
    child.once("error", () => fail("web_tunnel_start_failed"));
    child.once("close", () => {
      childClosed = true;
      healthy = false;
      isReady = false;
      resolveClosed();
      if (!closing) fail("web_tunnel_exited");
    });
  } catch {
    settleReady(failure("web_tunnel_start_failed"));
    try { cleanup(); } catch { throw failure("web_tunnel_cleanup_failed"); }
    throw failure("web_tunnel_start_failed");
  }
  signal?.addEventListener("abort", abort, { once: true });
  startupTimer = setTimeout(() => fail("web_tunnel_not_ready"), startupMs);
  startupTimer.unref();
  pollTimer = setInterval(() => void pollHealth(), 1_000);
  pollTimer.unref();
  if (signal?.aborted) abort();
  return {
    ready,
    close,
    status: () => ({
      state: failureCode ? "failed" : stopped ? "stopped" : closing ? "stopping" : isReady ? "ready" : "starting",
      running: spawned && !childClosed,
      healthy,
      ready: isReady,
      pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
      ...(failureCode ? { error: failureCode } : {}),
    }),
  };
}
