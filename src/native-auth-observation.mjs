import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { writePrivateJsonAsync } from "./file-security.mjs";
import { NATIVE_AUTH_OBSERVATION_PATH } from "./paths.mjs";

const VERSION = 1;
const STATES = new Set(["accepted", "rejected"]);
const DESKTOP_CACHE_MS = 5 * 60_000;
let cachedDesktop;
let cachedDesktopAt = 0;
let observationTail = Promise.resolve();

function processIdentities(listing) {
  return String(listing || "")
    .split(/\r?\n/)
    .map((line) => /^([^\t]+)\t(\d+)\t(.+)$/.exec(line))
    .filter((match) => match && /^(?:ChatGPT|Codex)$/i.test(match[1]))
    .map((match) => `${match[2]}|${match[3]}`);
}

function processCommand() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-Process -Name ChatGPT,Codex | ForEach-Object {",
    "  try {",
    '    [Console]::Out.WriteLine(("{0}`t{1}`t{2}" -f $_.ProcessName, $_.StartTime.ToUniversalTime().Ticks, $_.Path))',
    "  } catch {}",
    "}",
  ].join("\n");
  return ["powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]];
}

function processListing() {
  const [command, args] = processCommand();
  return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5_000,
  });
}

function processListingAsync() {
  const [command, args] = processCommand();
  return new Promise((resolve, reject) => {
    execFile(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 5_000,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function desktopFromListing(listing) {
  const identities = processIdentities(listing)
    .filter((identity) => !/\\OpenAI\\Codex\\bin\\[^\\]+\\codex\.exe$/i.test(identity))
    .sort((left, right) => identityStart(left) - identityStart(right));
  return identities.length === 0
    ? { running: false, generation: undefined }
    : {
        running: true,
        generation: createHash("sha256").update(identities[0]).digest("hex"),
      };
}

function identityStart(identity) {
  const value = String(identity || "");
  const windows = /^(\d+)\|/.exec(value);
  return windows ? Number(windows[1]) : Number.MAX_SAFE_INTEGER;
}

export function codexDesktopState(options = {}) {
  const {
    processList,
    processListReader = processListing,
    forceRefresh = false,
    now = Date.now(),
  } = options;
  const cacheable = processList === undefined &&
    processListReader === processListing;
  if (
    cacheable &&
    !forceRefresh &&
    cachedDesktop &&
    now - cachedDesktopAt < DESKTOP_CACHE_MS
  ) return cachedDesktop;
  try {
    const listing = processList === undefined ? processListReader() : processList;
    const desktop = desktopFromListing(listing);
    if (cacheable) {
      cachedDesktop = desktop;
      cachedDesktopAt = now;
    }
    return desktop;
  } catch {
    // Failure to inspect processes is unknown, never evidence that desktop is
    // closed or that a stale observation belongs to this launch.
    const desktop = { running: true, generation: undefined };
    if (cacheable) {
      cachedDesktop = desktop;
      cachedDesktopAt = now;
    }
    return desktop;
  }
}

export async function codexDesktopStateAsync(options = {}) {
  const {
    processList,
    processListReaderAsync = processListingAsync,
    forceRefresh = false,
    now = Date.now(),
  } = options;
  const cacheable = processList === undefined &&
    processListReaderAsync === processListingAsync;
  if (
    cacheable &&
    !forceRefresh &&
    cachedDesktop &&
    now - cachedDesktopAt < DESKTOP_CACHE_MS
  ) return cachedDesktop;
  try {
    const listing = processList === undefined
      ? await processListReaderAsync()
      : processList;
    const desktop = desktopFromListing(listing);
    if (cacheable) {
      cachedDesktop = desktop;
      cachedDesktopAt = now;
    }
    return desktop;
  } catch {
    const desktop = { running: true, generation: undefined };
    if (cacheable) {
      cachedDesktop = desktop;
      cachedDesktopAt = now;
    }
    return desktop;
  }
}

export function readNativeAuthObservation({
  filePath = NATIVE_AUTH_OBSERVATION_PATH,
  desktop = codexDesktopState(),
} = {}) {
  const unknown = { state: "unknown", desktop };
  if (!desktop.running || !desktop.generation || !existsSync(filePath)) return unknown;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      parsed?.version !== VERSION ||
      !STATES.has(parsed.state) ||
      parsed.desktopGeneration !== desktop.generation ||
      !Number.isFinite(Date.parse(parsed.observedAt))
    ) return unknown;
    return { state: parsed.state, observedAt: parsed.observedAt, desktop };
  } catch {
    return unknown;
  }
}

async function readNativeAuthObservationAsync(filePath, desktop) {
  const unknown = { state: "unknown", desktop };
  if (!desktop.running || !desktop.generation) return unknown;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (
      parsed?.version !== VERSION ||
      !STATES.has(parsed.state) ||
      parsed.desktopGeneration !== desktop.generation ||
      !Number.isFinite(Date.parse(parsed.observedAt))
    ) return unknown;
    return { state: parsed.state, observedAt: parsed.observedAt, desktop };
  } catch {
    return unknown;
  }
}

async function observeNativeAuthOutcomeNow(state, {
  filePath = NATIVE_AUTH_OBSERVATION_PATH,
  desktop,
  desktopOptions,
  now = Date.now(),
} = {}) {
  const currentDesktop = desktop || await codexDesktopStateAsync({
    ...desktopOptions,
    forceRefresh: state === "rejected",
    now,
  });
  if (!currentDesktop.running || !currentDesktop.generation) {
    return { state: "unknown", desktop: currentDesktop };
  }
  const existing = await readNativeAuthObservationAsync(filePath, currentDesktop);
  if (existing.state === state) return existing;
  const value = {
    version: VERSION,
    state,
    observedAt: new Date(now).toISOString(),
    desktopGeneration: currentDesktop.generation,
  };
  try {
    await writePrivateJsonAsync(filePath, value);
  } catch {
    return { state: "unknown", desktop: currentDesktop };
  }
  return { ...value, desktop: currentDesktop };
}

export function observeNativeAuthOutcome(status, options = {}) {
  const state = Number(status) === 401
    ? "rejected"
    : Number(status) >= 200 && Number(status) < 300
      ? "accepted"
      : "unknown";
  if (state === "unknown") return Promise.resolve({ state, desktop: options.desktop });

  // Request responses can finish close together, while process inspection and
  // Windows ACL protection complete at different speeds. Apply transitions in
  // invocation order so an older success can never overtake a later 401.
  const observation = observationTail.then(() => observeNativeAuthOutcomeNow(state, options));
  observationTail = observation.catch(() => {});
  return observation;
}

export function nativeCatalogPublicationMode(auth, desktop, observation) {
  if (auth?.authenticated === true) return "all";
  if (!desktop?.running) return "none";
  if (observation?.state === "accepted") return "all";
  if (observation?.state === "rejected") return "none";
  return "preserve";
}
