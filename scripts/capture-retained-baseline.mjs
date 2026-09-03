import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRetainedTests } from "./run-retained-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessFiles = [
  "scripts/capture-retained-baseline.mjs",
  "scripts/run-retained-tests.mjs",
  "maintenance/retained-tests.json",
];
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".kts",
  ".m", ".mjs", ".mm", ".php", ".ps1", ".py", ".rb", ".rs", ".sh", ".swift",
  ".ts", ".tsx", ".vue", ".zsh",
]);
const forbiddenKey = /(authorization|bearer|capability|command.?line|credential|hostname|home.?dir|secret|token|user.?name)/iu;

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function measurementHarness() {
  const manifestPath = path.join(root, "maintenance", "retained-tests.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return {
    identity: "The harness is not present at the measured historical commit; these hashes and embedded selections identify the exact later measurement method applied to that checkout.",
    files: harnessFiles.map((file) => ({
      file,
      sha256: sha256File(path.join(root, ...file.split("/"))),
    })),
    retainedManifest: {
      schemaVersion: manifest.schemaVersion,
      selections: manifest.selections,
    },
  };
}

export function parseLsTree(output) {
  const files = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^\d+\s+\w+\s+[0-9a-f]+\s+(\d+)\t(.+)$/u.exec(line);
    if (!match) throw new Error(`unexpected git ls-tree record: ${line}`);
    files.push({ bytes: Number(match[1]), path: match[2] });
  }
  return files;
}

export function sourceMetrics(files) {
  const source = files.filter((file) => sourceExtensions.has(path.extname(file.path).toLowerCase()));
  return {
    trackedFiles: files.length,
    trackedBlobBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sourceFiles: source.length,
    sourceBlobBytes: source.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function summarizeWorktree(porcelain) {
  const records = porcelain.split(/\r?\n/u).filter(Boolean);
  return {
    clean: records.length === 0,
    changedPathCount: records.length,
    trackedChangeCount: records.filter((record) => !record.startsWith("??")).length,
    untrackedPathCount: records.filter((record) => record.startsWith("??")).length,
  };
}

export function assertSanitized(value, location = "baseline") {
  if (Array.isArray(value)) {
    value.forEach((member, index) => assertSanitized(member, `${location}[${index}]`));
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, member] of Object.entries(value)) {
    if (forbiddenKey.test(key)) throw new Error(`sensitive field is forbidden at ${location}.${key}`);
    assertSanitized(member, `${location}.${key}`);
  }
  return value;
}

export function withTemporaryDirectory(callback, { tempRoot = os.tmpdir() } = {}) {
  const directory = mkdtempSync(path.join(tempRoot, "codex-router-retained-baseline-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function withTemporaryDirectoryAsync(callback, { tempRoot = os.tmpdir() } = {}) {
  const directory = mkdtempSync(path.join(tempRoot, "codex-router-retained-baseline-"));
  try {
    return await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function packageMetrics(commit, version, sourceRoot) {
  return withTemporaryDirectory((directory) => {
    const archive = path.join(directory, "source.tar.gz");
    const prefix = `codex-router-${version}/`;
    command("git", ["archive", "--format=tar.gz", `--prefix=${prefix}`, "-o", archive, commit], { cwd: sourceRoot });
    const contents = readFileSync(archive);
    return {
      definition: "Git release tar.gz from the exact commit with the release prefix",
      command: ["git", "archive", "--format=tar.gz", `--prefix=${prefix}`, "-o", "<temporary-file>", commit],
      raw: {
        bytes: statSync(archive).size,
        fileCount: parseLsTree(command("git", ["ls-tree", "-r", "-l", commit], { cwd: sourceRoot })).length,
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    };
  });
}

function toolVersion(executable, args) {
  try {
    return command(executable, args);
  } catch {
    return "unavailable";
  }
}

export function sanitizedEnvironment() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    osRelease: os.release(),
    osVersion: os.version(),
    architecture: os.arch(),
    cpuModel: cpus[0]?.model.trim() || "unavailable",
    logicalProcessors: cpus.length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    git: toolVersion("git", ["--version"]),
    npm: process.platform === "win32"
      ? toolVersion("cmd.exe", ["/d", "/s", "/c", "npm --version"])
      : toolVersion("npm", ["--version"]),
    powershell: process.platform === "win32" ? toolVersion("pwsh.exe", ["--version"]) : "not-applicable",
  };
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("failed to allocate a fixture loopback port");
  return port;
}

function fixtureEnvironment(directory, ports, catalogPath, internalKey, callerKey) {
  const inherited = {};
  for (const name of ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "windir"]) {
    if (process.env[name]) inherited[name] = process.env[name];
  }
  return {
    ...inherited,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"),
    CODEX_HOME: path.join(directory, "codex-home"),
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: path.join(directory, "state"),
    CODEX_ROUTER_STATE_DIR: path.join(directory, "state"),
    CODEX_ROUTER_CATALOG: catalogPath,
    CODEX_ROUTER_INTERNAL_KEY: internalKey,
    CODEX_ROUTER_CALLER_KEY: callerKey,
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${ports.gateway}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${ports.gateway}/health/liveliness`,
    CODEX_ROUTER_PORT: String(ports.router),
    MODEL_ROUTER_PORT: String(ports.router),
    CODEX_ROUTER_GATEWAY_PORT: String(ports.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(ports.oauth),
    CODEX_ROUTER_API_PORT: String(ports.api),
    CODEX_ROUTER_GROK_OAUTH_PORT: String(ports.grokOauth),
    CODEX_ROUTER_DEVIN_CLI_PORT: String(ports.devinCli),
    CODEX_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(ports.antigravityOauth),
    CODEX_ROUTER_CURSOR_PUBLIC_PORT: String(ports.cursorPublic),
    CODEX_ROUTER_QUIET: "1",
    NO_COLOR: "1",
  };
}

async function windowsProcessMemory(pid) {
  if (process.platform !== "win32") return { status: "unavailable-on-this-platform" };
  const script = [
    `$p=Get-Process -Id ${pid} -ErrorAction Stop`,
    "[pscustomobject]@{workingSetBytes=[int64]$p.WorkingSet64;privateBytes=[int64]$p.PrivateMemorySize64}|ConvertTo-Json -Compress",
  ].join("; ");
  return JSON.parse(command("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function measureIsolatedRouterStartup({
  sourceRoot = root,
  tempRoot = os.tmpdir(),
  timeoutMs = 15_000,
  quietMilliseconds = 500,
  sampleCount = 5,
  sampleIntervalMilliseconds = 200,
} = {}) {
  let fixtureDirectory;
  let fixturePid;
  const measurement = await withTemporaryDirectoryAsync(async (directory) => {
    fixtureDirectory = directory;
    const ports = {
      gateway: await freeLoopbackPort(),
      router: await freeLoopbackPort(),
      oauth: await freeLoopbackPort(),
      api: await freeLoopbackPort(),
      grokOauth: await freeLoopbackPort(),
      devinCli: await freeLoopbackPort(),
      antigravityOauth: await freeLoopbackPort(),
      cursorPublic: await freeLoopbackPort(),
    };
    const gateway = http.createServer((request, response) => {
      const body = Buffer.from(JSON.stringify({ status: "healthy" }));
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(ports.gateway, "127.0.0.1", resolve);
    });

    const catalogPath = path.join(directory, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ models: [] }));
    const stateDirectory = path.join(directory, "state");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(
      path.join(stateDirectory, "enabled-providers.json"),
      JSON.stringify({ version: 1, providers: [] }),
    );
    const internalKey = "fixture-internal-key-with-sufficient-length";
    const callerKey = "fixture-caller-key-with-sufficient-length";
    const environment = fixtureEnvironment(directory, ports, catalogPath, internalKey, callerKey);
    const entrypoint = path.join(sourceRoot, "src", "router.mjs");
    let child;
    const started = process.hrtime.bigint();
    try {
      child = spawn(process.execPath, [entrypoint], {
        cwd: sourceRoot,
        env: environment,
        stdio: "ignore",
        windowsHide: true,
      });
      fixturePid = child.pid;
      const deadline = Date.now() + timeoutMs;
      const healthUrl = `http://127.0.0.1:${ports.router}/_codex-router/${callerKey}/v1/health`;
      let readyPayload;
      let lastObservation = "connection unavailable";
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`isolated Router exited before readiness (${child.exitCode})`);
        try {
          const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
          const payload = await response.json();
          lastObservation = `HTTP ${response.status}; service=${String(payload.service)}; router=${String(payload.router)}; degraded=${JSON.stringify(payload.degraded || [])}`;
          if (response.ok && payload.service === "codex-router" && payload.router === "ready") {
            readyPayload = payload;
            break;
          }
        } catch (error) {
          // The listener is expected to refuse connections before it is ready.
          lastObservation = error instanceof Error && error.cause?.code
            ? String(error.cause.code)
            : "connection unavailable";
        }
        await delay(25);
      }
      if (!readyPayload) throw new Error(`isolated Router did not become authenticated and ready: ${lastObservation}`);
      const readinessMilliseconds = Number(process.hrtime.bigint() - started) / 1_000_000;
      await delay(quietMilliseconds);
      const memorySamples = [];
      for (let index = 0; index < sampleCount; index += 1) {
        memorySamples.push(await windowsProcessMemory(child.pid));
        if (index + 1 < sampleCount) await delay(sampleIntervalMilliseconds);
      }
      return {
        status: "measured",
        topology: "isolated-router-entrypoint-startup",
        comparableTo: "the same entrypoint fixture only; not the installed full-runtime diagnostic",
        authenticatedHealth: { service: readyPayload.service, version: readyPayload.version, router: readyPayload.router },
        raw: {
          readinessMilliseconds,
          fixtureChildCount: 1,
          quietMilliseconds,
          sampleCount,
          sampleIntervalMilliseconds,
          memorySamples,
        },
      };
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise((resolve) => child.once("close", resolve)),
          delay(2_000),
        ]);
      }
      await new Promise((resolve) => gateway.close(resolve));
    }
  }, { tempRoot });
  let fixtureProcessExited = true;
  if (fixturePid) {
    try {
      process.kill(fixturePid, 0);
      fixtureProcessExited = false;
    } catch {
      fixtureProcessExited = true;
    }
  }
  return {
    ...measurement,
    cleanup: {
      fixtureProcessExited,
      temporaryStateRemoved: fixtureDirectory ? !existsSync(fixtureDirectory) : false,
    },
  };
}

export async function captureBaseline({ includeTests = true, sourceRoot = root, expectedCommit } = {}) {
  const commit = command("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  if (expectedCommit && commit !== expectedCommit) {
    throw new Error(`source root is at ${commit}, expected ${expectedCommit}`);
  }
  const worktree = summarizeWorktree(command("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot }));
  const pkg = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const files = parseLsTree(command("git", ["ls-tree", "-r", "-l", commit], { cwd: sourceRoot }));
  const capturedAt = new Date().toISOString();
  const baseline = {
    schemaVersion: 1,
    kind: "retained-runtime-baseline",
    historical: false,
    capturedAt,
    repository: { commit, worktree },
    environment: sanitizedEnvironment(),
    measurementHarness: measurementHarness(),
    definitions: {
      source: "Sum of Git blob bytes at the exact commit; source is the checked-in extension set in this script",
      package: "Canonical release tar.gz produced by git archive",
      retainedTests: "Selections and exact name patterns in maintenance/retained-tests.json",
      isolatedStartup: "Authenticated isolated router.mjs entrypoint on fixture-owned state and nonproduction ports",
    },
    commands: {
      source: ["git", "ls-tree", "-r", "-l", commit],
      package: ["git", "archive", "--format=tar.gz", `--prefix=codex-router-${pkg.version}/`, "-o", "<temporary-file>", commit],
      retainedTests: ["node", "scripts/run-retained-tests.mjs"],
    },
    measurements: {
      source: { raw: sourceMetrics(files) },
      package: packageMetrics(commit, pkg.version, sourceRoot),
      isolatedStartup: await measureIsolatedRouterStartup({ sourceRoot }),
      liveRuntimeDiagnostic: {
        status: "not-captured",
        reason: "Automatic live-process inspection is excluded because process command lines, task metadata, and foreign processes are outside this artifact's safe evidence boundary.",
      },
      retainedTests: includeTests ? runRetainedTests({ repoRoot: sourceRoot }) : { status: "not-run" },
    },
    redactions: [
      "No environment dump",
      "No hostname or user identity",
      "No process command lines or executable paths",
      "No task metadata",
      "No credentials, capabilities, authenticated URLs, prompts, or response bodies",
      "Worktree paths omitted; only counts retained",
    ],
  };
  return assertSanitized(baseline);
}

async function main() {
  const includeTests = !process.argv.includes("--skip-tests");
  const sourceRootIndex = process.argv.indexOf("--source-root");
  const expectedCommitIndex = process.argv.indexOf("--expected-commit");
  const sourceRoot = sourceRootIndex >= 0 ? path.resolve(process.argv[sourceRootIndex + 1]) : root;
  const expectedCommit = expectedCommitIndex >= 0 ? process.argv[expectedCommitIndex + 1] : undefined;
  const baseline = await captureBaseline({ includeTests, sourceRoot, expectedCommit });
  process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
