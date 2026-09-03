import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandOnPath, preferSpawnablePath, spawnableCommand } from "./spawnable-command.mjs";

const discoveryDisabled = () => false;

export { preferSpawnablePath, spawnableCommand };

// The ChatGPT/Codex desktop app bundles its CLI under a version-hashed
// directory, e.g. %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe. That hash
// changes on every app update, so scan for the newest installed version
// instead of pinning a single path.
function desktopAppBundledCodexCandidates({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (platform !== "win32") return [];
  if (!localAppData) return [];
  const binDir = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(binDir)) return [];
  try {
    return readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binDir, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate));
  } catch {
    return [];
  }
}

function codexCandidatePaths({
  localAppData = process.env.LOCALAPPDATA,
  home = os.homedir(),
} = {}) {
  return [
    process.env.CODEX_BIN,
    process.env.CODEX_INSTALL_DIR && path.join(process.env.CODEX_INSTALL_DIR, "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "app", "bin", "codex.exe"),
    ...desktopAppBundledCodexCandidates({ platform: "win32", localAppData }),
    path.join(home, ".local", "bin", "codex.exe"),
  ].filter(Boolean);
}

function candidates() {
  return codexCandidatePaths();
}

function parsedCodexVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(
    String(value || ""),
  );
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") || [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left[index]) - Number(right[index]);
      if (delta !== 0) return Math.sign(delta);
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const delta = left[index].localeCompare(right[index]);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function compareCodexVersions(left, right) {
  const parsedLeft = parsedCodexVersion(left);
  const parsedRight = parsedCodexVersion(right);
  if (!parsedLeft && !parsedRight) return 0;
  if (!parsedLeft) return -1;
  if (!parsedRight) return 1;
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const delta = parsedLeft.core[index] - parsedRight.core[index];
    if (delta !== 0) return Math.sign(delta);
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function codexBinaryVersion(binary) {
  try {
    const target = spawnableCommand(binary, ["--version"]);
    return execFileSync(target.command, target.args, {
      ...target.options,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

function newestCodexBinary(candidatePaths, versionFor = codexBinaryVersion) {
  const existing = [...new Set(candidatePaths)]
    .filter((candidate) => candidate && existsSync(candidate));
  if (existing.length === 0) return undefined;
  let selected = existing[0];
  let selectedVersion = versionFor(selected);
  for (const candidate of existing.slice(1)) {
    const candidateVersion = versionFor(candidate);
    if (compareCodexVersions(candidateVersion, selectedVersion) > 0) {
      selected = candidate;
      selectedVersion = candidateVersion;
    }
  }
  return selected;
}

export function findCodexBinary() {
  // Explicit operator choices outrank discovery, even when another installed
  // build is newer. They are configuration, not candidates.
  const explicit = [
    process.env.CODEX_BIN,
    process.env.CODEX_INSTALL_DIR && path.join(process.env.CODEX_INSTALL_DIR, "codex.exe"),
  ].find((candidate) => candidate && existsSync(candidate));
  if (explicit) return explicit;

  // Never use installation-path order as a version signal. The Windows
  // desktop app and a standalone CLI can coexist, and the older standalone
  // path used to win even while the app was running a newer harness.
  const found = commandOnPath("codex");
  return newestCodexBinary([...candidates(), found]);
}

function requireCodexBinary() {
  const binary = findCodexBinary();
  if (!binary) {
    throw new Error(
      "The Codex binary was not found. Install Codex or set CODEX_BIN to its CLI binary.",
    );
  }
  return binary;
}

export function runCodex(args, options = {}) {
  const target = spawnableCommand(requireCodexBinary(), args);
  return execFileSync(target.command, target.args, {
    windowsHide: true,
    ...target.options,
    ...options,
  });
}

// The version tells catalog code whether a cached native capture came from
// the currently installed build. Undefined means "could not ask", which
// callers must treat as unknown rather than as a mismatch.
export function codexVersion() {
  try {
    const output = runCodex(["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Failing to *run* Codex is not evidence that the user is signed out. The two
// used to be indistinguishable, so one Windows spawn error silently stripped
// every native model from the catalog. Report the reason so callers can refuse
// to act on an unknown instead of treating it as a definite "logged out".
export function codexAuthStatus() {
  // `codex login status` is a credential probe, so --no-discovery skips the
  // spawn entirely. The distinct reason keeps this apart from "probe-failed":
  // the catalog treats it like a deliberate signed-out answer (publish no
  // native models) instead of refusing to rebuild.
  if (discoveryDisabled()) {
    return { authenticated: false, reason: "discovery-disabled" };
  }
  const binary = findCodexBinary();
  if (!binary) return { authenticated: false, reason: "codex-not-found" };
  try {
    // Inside the try: a path this module refuses to hand to a shell is a probe
    // that could not run, which is the "unknown" this function exists to
    // report -- not an exception for every caller to learn to expect.
    const target = spawnableCommand(binary, ["login", "status"]);
    execFileSync(target.command, target.args, {
      ...target.options,
      timeout: 10_000,
      stdio: "ignore",
      windowsHide: true,
    });
    return { authenticated: true, reason: "authenticated", binary };
  } catch (error) {
    // A numeric status means Codex ran and reported a signed-out session.
    // Anything else (ENOENT, EACCES, timeout) means the probe never completed.
    const probeFailed = typeof error?.status !== "number";
    return {
      authenticated: false,
      reason: probeFailed ? "probe-failed" : "signed-out",
      binary,
      ...(probeFailed && error?.code ? { code: error.code } : {}),
    };
  }
}
