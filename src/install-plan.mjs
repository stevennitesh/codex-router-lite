// Every update runs the whole installer, so the expensive dependency steps are
// gated on a fingerprint of the inputs they consume. A code-only update then
// costs a service restart instead of a full `npm ci` plus a fresh PyPI
// resolution of the LiteLLM proxy tree.
//
// Each stamp lives next to the artifact it describes (`node_modules/`,
// `.venv/`), so deleting the artifact invalidates the stamp automatically and
// no state directory has to stay in sync with the checkout.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { venvRuntimeProblem } from "./venv-runtime.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// requirements/python.in owns the direct gateway pins. A pin change must
// regenerate the Windows lock and boot the real gateway before acceptance.
//
// The independent LiteLLM security floor fixed CVE-2026-84377. Regenerating
// the lock must not make an older vulnerable gateway eligible for installation.
const LITELLM_SECURITY_FLOOR = [1, 96, 2];

// Pinning the two direct requirements left their whole transitive tree floating:
// every install re-resolved `litellm[proxy]` against PyPI and executed whatever
// it got. `requirements/python.txt` is the hash-verified closure of the pins
// in python.in, and both installation tools install *from that file* with
// `--require-hashes` instead of naming the packages themselves. That is also
// why the version literals no longer appear in the shell scripts. Three copies
// of one rule had drifted apart, and the fix is fewer copies rather
// than more comments asking people to keep them in step.
//
// Slash-separated on purpose because these are repository paths.
const PYTHON_LOCK = "requirements/python.txt";
const PYTHON_LOCK_INPUT = "requirements/python.in";

// The product runs on Windows, so the lock resolves only the Windows dependency
// graph for CPython 3.10+. `pythonLockDrift` checks the platform and hash flags
// uv records in the header as well as the direct pins.

function repoPath(root, relative) {
  return path.join(root, ...relative.split("/"));
}

const STAMP_NAME = ".codex-router-install.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readFile(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function requirementParts(requirement) {
  const [specifier, version] = String(requirement).split("==");
  return { name: specifier.replace(/\[[^\]]*\]$/, "").trim(), version: (version || "").trim() };
}

export function pythonRequirements(root = SOURCE_ROOT) {
  const contents = readFile(repoPath(root, PYTHON_LOCK_INPUT));
  if (contents === undefined) throw new Error(`${PYTHON_LOCK_INPUT} is missing`);
  const requirements = contents.split("\n").map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!requirements.length || requirements.some((line) =>
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?==[^\s;]+$/u.test(line))) {
    throw new Error(`${PYTHON_LOCK_INPUT} must contain exact direct requirement pins`);
  }
  const names = requirements.map((line) => normalizeProject(requirementParts(line).name));
  if (new Set(names).size !== names.length) {
    throw new Error(`${PYTHON_LOCK_INPUT} contains duplicate direct requirements`);
  }
  const specifiers = requirements.map((line) => line.split("==")[0]).sort();
  if (specifiers.join(",") !== "fastapi,litellm[proxy]") {
    throw new Error(`${PYTHON_LOCK_INPUT} must pin fastapi and litellm[proxy]`);
  }
  const litellm = requirements.find((line) => line.startsWith("litellm[proxy]=="));
  const version = requirementParts(litellm).version;
  const stable = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  const parts = stable?.slice(1).map(Number);
  const difference = parts?.map((part, index) => part - LITELLM_SECURITY_FLOOR[index]).find((part) => part !== 0) ?? 0;
  if (!stable || difference < 0) {
    throw new Error(`LiteLLM must use a stable version at or above ${LITELLM_SECURITY_FLOOR.join(".")}`);
  }
  return requirements;
}

function sitePackages(root, platform) {
  if (platform !== "win32") throw new Error(`Unsupported install platform: ${platform}`);
  return [path.join(root, ".venv", "Lib", "site-packages")];
}

// Distribution directories normalize the project name, so `litellm[proxy]`
// installs as `litellm-1.95.0.dist-info`.
function installedDistributionVersion(name, { root = SOURCE_ROOT, platform = process.platform } = {}) {
  const normalized = name.toLowerCase().replace(/[-_.]+/g, "_");
  for (const directory of sitePackages(root, platform)) {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".dist-info")) continue;
      const base = entry.slice(0, -".dist-info".length);
      const separator = base.lastIndexOf("-");
      if (separator <= 0) continue;
      if (base.slice(0, separator).toLowerCase().replace(/[-_.]+/g, "_") === normalized) {
        return base.slice(separator + 1);
      }
    }
  }
  return undefined;
}

function venvPython(root, platform) {
  if (platform !== "win32") throw new Error(`Unsupported install platform: ${platform}`);
  return path.join(root, ".venv", "Scripts", "python.exe");
}

// uv writes `version_info`, the stdlib venv module writes `version`.
function venvPythonVersion(root) {
  const config = readFile(path.join(root, ".venv", "pyvenv.cfg")) || "";
  const match = config.match(/^\s*version(?:_info)?\s*=\s*(\d+\.\d+)/m);
  return match ? match[1] : "unknown";
}

// The venv records the base interpreter it was created from. If that directory
// disappears, the venv is unusable even when its launcher remains. Treat an
// unresolvable home as "not installed" so every install/update rebuilds it.
function venvPythonHomeUsable(root = SOURCE_ROOT) {
  const config = readFile(path.join(root, ".venv", "pyvenv.cfg")) || "";
  const match = config.match(/^\s*home\s*=\s*(.+)$/m);
  if (!match) return true; // unknown; the interpreter probe decides
  const home = match[1].trim();
  return existsSync(home);
}

const STEPS = {
  "node-deps": {
    stamp: (root) => path.join(root, "node_modules", STAMP_NAME),
    fingerprint: (root) =>
      sha256(
        [
          `node:${process.versions.node.split(".")[0]}`,
          readFile(path.join(root, "package-lock.json")) ?? "",
        ].join("\0"),
      ),
    // npm writes this tree summary on every successful install; a partially
    // deleted `node_modules` therefore reads as "not installed".
    installed: (root) => existsSync(path.join(root, "node_modules", ".package-lock.json")),
  },
  "python-deps": {
    stamp: (root) => path.join(root, ".venv", STAMP_NAME),
    // The lock is an input now, not just the two pins. A regenerated lock moves
    // transitive versions while the direct requirements stay put, and without the
    // lock in the fingerprint that update would be skipped as "already matches".
    fingerprint: (root) =>
      sha256(
        [
          `python:${venvPythonVersion(root)}`,
          ...pythonRequirements(root),
          readFile(repoPath(root, PYTHON_LOCK)) ?? "",
        ].join("\0"),
      ),
    installed: (root, platform, { runtimeProblem = venvRuntimeProblem } = {}) => {
      // A venv whose interpreter home disappeared must read as "not installed" so the
      // next install/update rebuilds it instead of skipping a broken venv.
      if (!venvPythonHomeUsable(root)) return false;
      const python = venvPython(root, platform);
      if (!existsSync(python)) return false;
      // A launcher can remain after its stdlib or recorded interpreter home
      // has disappeared. Use the same startup probe as doctor/start so an
      // update repairs a venv that exists on disk but cannot execute Python.
      if (runtimeProblem(python)) return false;
      return pythonRequirements(root).every((requirement) => {
        const { name, version } = requirementParts(requirement);
        return installedDistributionVersion(name, { root, platform }) === version;
      });
    },
  },
};

export function stepStatus(
  step,
  {
    root = SOURCE_ROOT,
    platform = process.platform,
    runtimeProblem = venvRuntimeProblem,
  } = {},
) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  if (!definition.installed(root, platform, { runtimeProblem })) return "run";
  const stamp = readFile(definition.stamp(root));
  if (!stamp) return "run";
  try {
    const parsed = JSON.parse(stamp);
    return parsed?.fingerprint === definition.fingerprint(root) ? "skip" : "run";
  } catch {
    return "run";
  }
}

export function recordStep(step, { root = SOURCE_ROOT } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  const target = definition.stamp(root);
  writeFileSync(
    target,
    `${JSON.stringify({ version: 1, step, fingerprint: definition.fingerprint(root) }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return target;
}

// A pinned line in a pip requirements file: `name[extra]==version`, optionally
// followed by an environment marker and the backslash that continues into the
// `--hash=` lines. A universal lock names the same package more than once when
// the resolution differs per Python version, so versions collect into a list.
const LOCK_PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==([^\s;\\]+)/;
const LOCK_HASH = /--hash=sha256:[0-9a-f]{64}/;

// PyPI treats `-`, `_`, and `.` as the same character in a project name, so the
// lock and the direct requirements can spell one package two ways.
function normalizeProject(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// Returns one entry per pinned line: its project, version, and whether the line
// carries at least one hash. An entry without hashes is the failure this whole
// mechanism exists to prevent, so it is reported rather than skipped.
function parseLock(contents) {
  const entries = [];
  let current;
  for (const line of String(contents).split("\n")) {
    const pin = LOCK_PIN.exec(line);
    if (pin) {
      current = { project: normalizeProject(pin[1]), version: pin[3], hashes: 0 };
      if (LOCK_HASH.test(line)) current.hashes += 1;
      entries.push(current);
      continue;
    }
    if (current && LOCK_HASH.test(line)) current.hashes += 1;
    // A blank line ends the continuation, so a later `--hash` cannot be
    // credited to a requirement it does not belong to.
    if (!line.trim()) current = undefined;
  }
  return entries;
}

// Every way the lock can stop describing the direct requirements. An earlier lock
// pinned LiteLLM twelve minor versions behind main without failing, so each
// condition returns a sentence rather
// than a boolean.
export function pythonLockDrift(root = SOURCE_ROOT) {
  const problems = [];
  const contents = readFile(repoPath(root, PYTHON_LOCK));
  if (contents === undefined) {
    return [`${PYTHON_LOCK} is missing; regenerate it with uv pip compile`];
  }

  const requirements = pythonRequirements(root);

  // The recorded command is part of the product boundary: a universal lock
  // silently restores dependencies for operating systems this repo does not support.
  const header = contents.split("\n").slice(0, 8).join(" ");
  for (const flag of ["--python-platform windows", "--generate-hashes"]) {
    if (!header.includes(flag)) {
      problems.push(`${PYTHON_LOCK} was not generated with ${flag}`);
    }
  }
  if (header.includes("--universal")) {
    problems.push(`${PYTHON_LOCK} must not include the unsupported universal dependency graph`);
  }

  const entries = parseLock(contents);
  if (!entries.length) problems.push(`${PYTHON_LOCK} pins no distributions`);
  const unhashed = entries.filter((entry) => entry.hashes === 0);
  if (unhashed.length) {
    problems.push(
      `${PYTHON_LOCK} has ${unhashed.length} requirement(s) without a hash: ` +
        unhashed.map((entry) => `${entry.project}==${entry.version}`).join(", "),
    );
  }

  for (const requirement of requirements) {
    const { name, version } = requirementParts(requirement);
    const locked = entries.filter((entry) => entry.project === normalizeProject(name));
    if (!locked.length) {
      problems.push(`${PYTHON_LOCK} does not pin ${name}`);
      continue;
    }
    const wrong = locked.filter((entry) => entry.version !== version);
    if (wrong.length) {
      problems.push(
        `${PYTHON_LOCK} pins ${name}==${wrong.map((entry) => entry.version).join("/")} ` +
          `but ${PYTHON_LOCK_INPUT} asks for ${version}`,
      );
    }
  }
  return problems;
}

function main(argv) {
  const [command, step] = argv;
  if (command === "status") {
    // Fail open: an unexpected error must run the step, never skip it.
    let status = "run";
    try {
      status = stepStatus(step);
    } catch {
      status = "run";
    }
    process.stdout.write(`${status}\n`);
    return 0;
  }
  if (command === "record") {
    recordStep(step);
    return 0;
  }
  if (command === "requirements") {
    process.stdout.write(`${pythonRequirements().join("\n")}\n`);
    return 0;
  }
  if (command === "verify-lock") {
    const problems = pythonLockDrift();
    if (problems.length) {
      throw new Error(`Python dependency lock verification failed:\n- ${problems.join("\n- ")}`);
    }
    process.stdout.write("Python dependency lock verified\n");
    return 0;
  }
  // `venv-home-ok` — 0/1 whether the recorded venv interpreter home still
  // exists. The installers use this to decide whether a *present* venv must
  // be cleared and recreated: `status python-deps` already returns "run" for
  // a broken home, but the uv branch only recreates the venv when the python
  // launcher itself is absent, so an existing-but-broken venv would otherwise
  // be pip-installed into without ever rewriting pyvenv.cfg.
  if (command === "venv-home-ok") {
    const usable = venvPythonHomeUsable();
    process.stdout.write(usable ? "ok\n" : "damaged\n");
    return usable ? 0 : 1;
  }
  if (command === "venv-runtime-ok") {
    const problem = venvRuntimeProblem(venvPython(SOURCE_ROOT, process.platform));
    process.stdout.write(problem ? "damaged\n" : "ok\n");
    return problem ? 1 : 0;
  }
  console.error(
    "Usage: install-plan.mjs status|record <node-deps|python-deps> | requirements | " +
      "verify-lock | venv-home-ok | venv-runtime-ok",
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
