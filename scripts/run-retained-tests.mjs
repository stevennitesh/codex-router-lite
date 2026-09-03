import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = path.join(root, "maintenance", "retained-tests.json");
const excludedPathFragments = [
  "apps/control-center",
  "apps/macos",
  "subagent-ui",
  "tray-service",
];

function asPosix(value) {
  return String(value).replaceAll("\\", "/");
}

function decodeTestName(raw) {
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= raw.length) throw new Error("unterminated escape in test name");
    const escaped = raw[index];
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
    if (Object.hasOwn(simple, escaped)) {
      decoded += simple[escaped];
    } else if (escaped === "x") {
      const digits = raw.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/iu.test(digits)) throw new Error("invalid hexadecimal escape in test name");
      decoded += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 2;
    } else if (escaped === "u") {
      const braced = raw[index + 1] === "{";
      const end = braced ? raw.indexOf("}", index + 2) : index + 5;
      const digits = braced ? raw.slice(index + 2, end) : raw.slice(index + 1, end);
      if (end < 0 || !/^[0-9a-f]{1,6}$/iu.test(digits)) throw new Error("invalid Unicode escape in test name");
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) throw new Error("Unicode escape is outside the valid range");
      decoded += String.fromCodePoint(codePoint);
      index = braced ? end : end - 1;
    } else {
      decoded += escaped;
    }
  }
  return decoded;
}

export function discoverLiteralTopLevelTests(source) {
  const names = [];
  const literalTest = /^test\s*\(\s*(?:"((?:\\[\s\S]|[^"\\\r\n])*)"|'((?:\\[\s\S]|[^'\\\r\n])*)')/gmu;
  for (const match of source.matchAll(literalTest)) {
    names.push(decodeTestName(match[1] ?? match[2]));
  }
  return names;
}

function matchedManifestTestNames(selection, repoRoot) {
  if (!selection.testNamePattern) return undefined;
  const filePath = path.join(repoRoot, ...asPosix(selection.file).split("/"));
  const discovered = discoverLiteralTopLevelTests(readFileSync(filePath, "utf8"));
  if (discovered.length === 0) {
    throw new Error(`${selection.id} patterned test file has no statically discoverable literal top-level test names`);
  }
  const pattern = new RegExp(selection.testNamePattern, "u");
  const matched = discovered.filter((name) => pattern.test(name));
  if (matched.length === 0) throw new Error(`${selection.id} testNamePattern matched zero statically discovered tests`);
  return matched;
}

export function validateManifest(manifest, { repoRoot = root } = {}) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.selections)) {
    throw new Error("retained test manifest must use schemaVersion 1 and contain selections");
  }
  if (manifest.selections.length === 0) throw new Error("retained test manifest is empty");

  const ids = new Set();
  const coveredSurfaces = new Set();
  for (const selection of manifest.selections) {
    if (!selection || typeof selection !== "object") throw new Error("invalid retained test selection");
    if (typeof selection.id !== "string" || !selection.id) throw new Error("selection id is required");
    if (ids.has(selection.id)) throw new Error(`duplicate retained test selection id: ${selection.id}`);
    ids.add(selection.id);

    const file = asPosix(selection.file || "");
    if (!file.startsWith("test/") || !file.endsWith(".test.mjs") || file.includes("..")) {
      throw new Error(`${selection.id} must name a repository test file`);
    }
    if (excludedPathFragments.some((fragment) => file.toLowerCase().includes(fragment))) {
      throw new Error(`${selection.id} selects an excluded-only test file: ${file}`);
    }
    if (!existsSync(path.join(repoRoot, ...file.split("/")))) {
      throw new Error(`${selection.id} test file does not exist: ${file}`);
    }
    if (!Array.isArray(selection.surfaces) || selection.surfaces.length === 0) {
      throw new Error(`${selection.id} must name at least one retained surface`);
    }
    for (const surface of selection.surfaces) coveredSurfaces.add(surface);
    if (selection.testNamePattern !== undefined) {
      if (typeof selection.testNamePattern !== "string" || !selection.testNamePattern) {
        throw new Error(`${selection.id} has an invalid testNamePattern`);
      }
      try {
        new RegExp(selection.testNamePattern, "u");
      } catch (error) {
        throw new Error(`${selection.id} has an invalid testNamePattern: ${error.message}`);
      }
      matchedManifestTestNames(selection, repoRoot);
    }
  }

  const requiredSurfaces = [
    "native-codex",
    "openrouter-glm-5.3-flash",
    "switchyard",
    "app-function-restoration",
    "namespace-restoration",
    "collaboration-relay",
    "collaboration-v2",
    "windows-lifecycle",
  ];
  const missing = requiredSurfaces.filter((surface) => !coveredSurfaces.has(surface));
  if (missing.length) throw new Error(`retained test manifest misses surfaces: ${missing.join(", ")}`);
  return manifest;
}

export function loadManifest(manifestPath = defaultManifestPath, { repoRoot = root } = {}) {
  return validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), { repoRoot });
}

function summaryValue(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, "gmu"))];
  return matches.length ? Number(matches.at(-1)[1]) : undefined;
}

export function parseTapSummary(output) {
  const summary = {
    tests: summaryValue(output, "tests"),
    suites: summaryValue(output, "suites"),
    pass: summaryValue(output, "pass"),
    fail: summaryValue(output, "fail"),
    cancelled: summaryValue(output, "cancelled"),
    skipped: summaryValue(output, "skipped"),
    todo: summaryValue(output, "todo"),
  };
  const duration = [...output.matchAll(/^# duration_ms ([0-9.]+)\s*$/gmu)];
  summary.durationMilliseconds = duration.length ? Number(duration.at(-1)[1]) : undefined;
  if (!Number.isInteger(summary.tests) || !Number.isInteger(summary.pass) || !Number.isInteger(summary.fail)) {
    throw new Error("Node test output did not contain a complete TAP summary");
  }
  return summary;
}

export function runRetainedTests({ manifestPath = defaultManifestPath, repoRoot = root, spawn = spawnSync } = {}) {
  const manifest = loadManifest(manifestPath, { repoRoot });
  const started = process.hrtime.bigint();
  const runs = [];
  let totalMatched = 0;

  for (const selection of manifest.selections) {
    const manifestMatches = matchedManifestTestNames(selection, repoRoot);
    const args = ["--test", "--test-reporter=tap"];
    if (selection.testNamePattern) args.push(`--test-name-pattern=${selection.testNamePattern}`);
    args.push(selection.file);
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    const stdout = child.stdout || "";
    let summary;
    try {
      summary = parseTapSummary(stdout);
    } catch (error) {
      throw new Error(`${selection.id} produced invalid TAP: ${error.message}`);
    }
    const matched = manifestMatches?.length
      ?? summary.pass + summary.fail + (summary.cancelled || 0) + (summary.todo || 0);
    if (child.status !== 0 || summary.fail > 0 || (summary.cancelled || 0) > 0) {
      throw new Error(`${selection.id} failed (exit ${String(child.status)}; ${summary.fail} failed; ${summary.cancelled || 0} cancelled)`);
    }
    totalMatched += matched;
    runs.push({
      id: selection.id,
      surfaces: selection.surfaces,
      command: ["node", ...args],
      exitCode: child.status,
      matchedTests: matched,
      rawSummary: summary,
    });
  }

  const wallMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    manifest: asPosix(path.relative(root, manifestPath)),
    repositoryRoot: "<source-root>",
    command: ["node", asPosix(path.relative(root, fileURLToPath(import.meta.url)))],
    exitCode: 0,
    selectionCount: runs.length,
    matchedTests: totalMatched,
    wallMilliseconds,
    runs,
  };
}

function main() {
  const manifestIndex = process.argv.indexOf("--manifest");
  const repoRootIndex = process.argv.indexOf("--repo-root");
  const manifestArgument = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  const repoRoot = repoRootIndex >= 0 ? path.resolve(process.argv[repoRootIndex + 1]) : root;
  const result = runRetainedTests({
    manifestPath: manifestArgument ? path.resolve(manifestArgument) : defaultManifestPath,
    repoRoot,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
