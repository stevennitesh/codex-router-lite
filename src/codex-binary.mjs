import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

// The ChatGPT/Codex desktop app bundles its CLI under a version-hashed
// directory, e.g. %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe. That hash
// changes on every app update, so scan for the newest installed version
// instead of pinning a single path.
function desktopAppBundledCodexCandidates({
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
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

function codexCandidatePaths({ localAppData = process.env.LOCALAPPDATA } = {}) {
  return [
    process.env.CODEX_BIN,
    process.env.CODEX_INSTALL_DIR && path.join(process.env.CODEX_INSTALL_DIR, "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
    localAppData && path.join(localAppData, "Programs", "Codex", "resources", "app", "bin", "codex.exe"),
    ...desktopAppBundledCodexCandidates({ localAppData }),
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

function modifiedMs(candidate) {
  try {
    return statSync(candidate).mtimeMs;
  } catch {
    return 0;
  }
}

export function newestCodexBinary(
  candidatePaths,
  versionFor = codexBinaryVersion,
  modifiedFor = modifiedMs,
) {
  const existing = [...new Set(candidatePaths)]
    .filter((candidate) => candidate && existsSync(candidate));
  if (existing.length === 0) return undefined;
  let selected = existing[0];
  let selectedVersion = versionFor(selected);
  let selectedModifiedMs = modifiedFor(selected);
  for (const candidate of existing.slice(1)) {
    const candidateVersion = versionFor(candidate);
    const versionOrder = compareCodexVersions(candidateVersion, selectedVersion);
    const candidateModifiedMs = modifiedFor(candidate);
    if (
      versionOrder > 0 ||
      (versionOrder === 0 && candidateModifiedMs > selectedModifiedMs)
    ) {
      selected = candidate;
      selectedVersion = candidateVersion;
      selectedModifiedMs = candidateModifiedMs;
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

// Catalog reuse needs a build identity as well as `codex --version`. Desktop
// can replace a runtime without changing its version string, and an explicit
// CODEX_BIN can keep the same path. Hash only stable file metadata: reading a
// large signed executable on every five-minute catalog check is unnecessary.
export function codexBinaryFingerprint(binary = findCodexBinary()) {
  if (!binary) return undefined;
  try {
    const stats = statSync(binary);
    return createHash("sha256")
      .update(JSON.stringify({
        path: path.resolve(binary),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
      }))
      .digest("hex");
  } catch {
    return undefined;
  }
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

// Version and codexBinaryFingerprint() jointly identify the installed build.
// Undefined means "could not ask", which callers treat as unknown rather than
// as a mismatch.
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
export function codexAuthStatus({
  findBinary = findCodexBinary,
  execute = execFileSync,
} = {}) {
  const binary = findBinary();
  if (!binary) return { authenticated: false, reason: "codex-not-found" };
  try {
    // Inside the try: a path this module refuses to hand to a shell is a probe
    // that could not run, which is the "unknown" this function exists to
    // report -- not an exception for every caller to learn to expect.
    const target = spawnableCommand(binary, ["login", "status"]);
    execute(target.command, target.args, {
      ...target.options,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { authenticated: true, reason: "authenticated", binary };
  } catch (error) {
    const detail = [error?.code, error?.message, error?.stderr]
      .filter(Boolean)
      .join(" ");
    const accessDenied =
      error?.code === "EACCES" ||
      error?.code === "EPERM" ||
      /access (?:is )?denied|permission denied|unauthorizedaccess/iu.test(detail);
    const signedOut = /not (?:logged|signed) in|logged out|authentication required/iu.test(detail);
    return {
      authenticated: false,
      reason: accessDenied ? "access-denied" : signedOut ? "signed-out" : "probe-failed",
      binary,
      ...(error?.code ? { code: error.code } : {}),
    };
  }
}
