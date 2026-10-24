import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pythonLockDrift, pythonRequirements, recordStep, stepStatus, verifyNodeDependencies } from "../src/install-plan.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-install-plan-"));
  const requirements = path.join(root, "requirements");
  const packages = path.join(root, ".venv/Lib/site-packages");
  mkdirSync(requirements, { recursive: true });
  mkdirSync(packages, { recursive: true });
  mkdirSync(path.join(root, ".venv/Scripts"));
  writeFileSync(path.join(root, ".venv/Scripts/python.exe"), "fixture");
  writeFileSync(path.join(root, ".venv/pyvenv.cfg"), `home = ${root}\nversion = 3.12.12\n`);
  const setPins = (version) => {
    writeFileSync(path.join(requirements, "python.in"), `litellm[proxy]==${version}\nfastapi==0.141.1\n`);
    writeFileSync(path.join(requirements, "python.txt"), `# uv pip compile --python-platform windows --generate-hashes --python-version 3.11\nlitellm==${version} --hash=sha256:${"a".repeat(64)}\nfastapi==0.141.1 --hash=sha256:${"b".repeat(64)}\n`);
    mkdirSync(path.join(packages, `litellm-${version}.dist-info`), { recursive: true });
    mkdirSync(path.join(packages, "fastapi-0.141.1.dist-info"), { recursive: true });
  };
  setPins("1.104.0");
  return { root, requirements, packages, setPins };
}

test("Python direct pins own the lock and installed stamp, including changes to direct versions", () => {
  const f = fixture();
  const options = { root: f.root, platform: "win32", runtimeProblem: () => undefined };
  try {
    assert.deepEqual(pythonRequirements(f.root), ["litellm[proxy]==1.104.0", "fastapi==0.141.1"]);
    assert.deepEqual(pythonLockDrift(f.root), []);
    // Retained installations stamped the normalized direct pins. Moving their
    // source into python.in must reuse that same dependency identity.
    const priorFingerprint = createHash("sha256").update([
      "python:3.12", "litellm[proxy]==1.104.0", "fastapi==0.141.1",
      readFileSync(path.join(f.requirements, "python.txt"), "utf8"),
    ].join("\0")).digest("hex");
    writeFileSync(path.join(f.root, ".venv/.codex-router-install.json"), JSON.stringify({ version: 1, step: "python-deps", fingerprint: priorFingerprint }));
    assert.equal(stepStatus("python-deps", options), "skip");
    const input = path.join(f.requirements, "python.in");
    writeFileSync(input, `# Editorial instruction change\n${readFileSync(input, "utf8")}`);
    assert.equal(stepStatus("python-deps", options), "skip");
    rmSync(path.join(f.packages, "litellm-1.104.0.dist-info"), { recursive: true });
    f.setPins("1.105.0");
    assert.deepEqual(pythonLockDrift(f.root), []);
    assert.equal(stepStatus("python-deps", options), "run");
    recordStep("python-deps", options);
    assert.equal(stepStatus("python-deps", options), "skip");
    writeFileSync(path.join(f.requirements, "python.txt"), "invalid lock\n");
    assert.equal(stepStatus("python-deps", options), "run");
    assert.ok(pythonLockDrift(f.root).length > 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the Python lock must resolve for the supported minimum interpreter", () => {
  const f = fixture();
  try {
    const lock = path.join(f.requirements, "python.txt");
    const valid = readFileSync(lock, "utf8");
    for (const flag of ["", "--python-version 3.10", "--python-version 3.12", "--python-version 3.110"]) {
      writeFileSync(lock, valid.replace("--python-version 3.11", flag));
      assert.ok(pythonLockDrift(f.root).some(problem => problem.includes("--python-version 3.11")), flag);
    }
    writeFileSync(lock, valid);
    assert.deepEqual(pythonLockDrift(f.root), []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a matching stamp never skips a broken Python runtime or missing interpreter home", () => {
  const f = fixture();
  try {
    recordStep("python-deps", { root: f.root });
    assert.equal(stepStatus("python-deps", { root: f.root, platform: "win32", runtimeProblem: () => "broken stdlib" }), "run");
    writeFileSync(path.join(f.root, ".venv/pyvenv.cfg"), `home = ${path.join(f.root, "missing")}\nversion = 3.12.12\n`);
    assert.equal(stepStatus("python-deps", { root: f.root, platform: "win32", runtimeProblem: () => undefined }), "run");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Python status probes the runtime only when its stamp matches the current inputs", () => {
  const f = fixture();
  let probes = 0;
  const options = { root: f.root, platform: "win32", runtimeProblem: () => { probes += 1; } };
  try {
    const stamp = path.join(f.root, ".venv/.codex-router-install.json");
    assert.equal(stepStatus("python-deps", options), "run");
    assert.equal(probes, 0, "a missing stamp already requires installation");
    for (const contents of ["{", "{}"]) {
      writeFileSync(stamp, contents);
      assert.equal(stepStatus("python-deps", options), "run");
      assert.equal(probes, 0, "a malformed or incomplete stamp already requires installation");
    }
    recordStep("python-deps", options);
    const lock = path.join(f.requirements, "python.txt");
    writeFileSync(lock, `${readFileSync(lock, "utf8")}\n`);
    assert.equal(stepStatus("python-deps", options), "run");
    assert.equal(probes, 0, "changed dependency inputs already require installation");
    recordStep("python-deps", options);
    assert.equal(stepStatus("python-deps", options), "skip");
    assert.equal(probes, 1, "a matching stamp still requires a runtime probe");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("regenerating an exact lock cannot bypass the gateway security floor or required package set", () => {
  const f = fixture();
  try {
    f.setPins("1.96.1");
    assert.throws(() => pythonLockDrift(f.root), /at or above 1\.96\.2/u);
    f.setPins("1.96.2");
    assert.deepEqual(pythonLockDrift(f.root), []);
    writeFileSync(path.join(f.requirements, "python.in"), "litellm[proxy]==1.104.0\n");
    assert.throws(() => pythonRequirements(f.root), /fastapi and litellm/u);
    writeFileSync(path.join(f.requirements, "python.in"), "litellm[proxy]>=1.104.0\nfastapi==0.141.1\n");
    assert.throws(() => pythonRequirements(f.root), /exact direct requirement pins/u);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function nodeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-node-plan-"));
  const dependency = path.join(root, "node_modules/fixture-dependency");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: { "fixture-dependency": "1.0.0" } }));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "": { name: "fixture" }, "node_modules/fixture-dependency": { version: "1.0.0" },
  } }));
  writeFileSync(path.join(root, "node_modules/.package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/fixture-dependency": { version: "1.0.0" } } }));
  writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "index.cjs" }));
  writeFileSync(path.join(dependency, "index.cjs"), "module.exports = {ready:true};");
  return { root, dependency };
}
test("Node stamp requires exact package inputs and a complete usable locked tree", () => {
  const f = nodeFixture();
  try {
    assert.equal(verifyNodeDependencies(f.root), true);
    recordStep("node-deps", { root: f.root });
    assert.equal(stepStatus("node-deps", { root: f.root }), "skip");
    writeFileSync(path.join(f.root, "package.json"), readFileSync(path.join(f.root, "package.json"), "utf8") + "\n");
    assert.equal(stepStatus("node-deps", { root: f.root }), "run", "package input belongs to the stamp");
    recordStep("node-deps", { root: f.root });
    rmSync(path.join(f.dependency, "package.json"));
    assert.equal(stepStatus("node-deps", { root: f.root }), "run");
    assert.throws(() => recordStep("node-deps", { root: f.root }));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test("Node verifier refuses desired-input mismatch, omitted dependencies and broken imports", () => {
  for (const scenario of ["input", "hidden", "import"]) {
    const f = nodeFixture(), desired = nodeFixture();
    try {
      if (scenario === "input") writeFileSync(path.join(f.root, "package.json"), "{\"name\":\"wrong\"}");
      if (scenario === "hidden") writeFileSync(path.join(f.root, "node_modules/.package-lock.json"), JSON.stringify({ packages: {} }));
      if (scenario === "import") writeFileSync(path.join(f.dependency, "index.cjs"), "throw new Error('fixture broken import');");
      assert.throws(() => verifyNodeDependencies(f.root, desired.root), scenario === "input" ? /desired checkout inputs/u : scenario === "hidden" ? /missing or mismatched/u : /broken import/u);
    } finally { rmSync(f.root, { recursive: true, force: true }); rmSync(desired.root, { recursive: true, force: true }); }
  }
});

function sdkNodeFixture() {
  const f = nodeFixture();
  const name = "@modelcontextprotocol/sdk", version = "1.32.1";
  const dependency = path.join(f.root, "node_modules", name);
  const entries = ["server/index.js", "server/streamableHttp.js", "types.js", "validation/ajv-provider.js"];
  const manifestPath = path.join(f.root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies[name] = version;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const file of ["package-lock.json", "node_modules/.package-lock.json"]) {
    const target = path.join(f.root, file), lock = JSON.parse(readFileSync(target, "utf8"));
    lock.packages[`node_modules/${name}`] = { version };
    writeFileSync(target, JSON.stringify(lock));
  }
  mkdirSync(dependency, { recursive: true });
  writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name, version, type: "module", exports: {
    "./*": { import: "./dist/esm/*", require: "./dist/cjs/*" },
  } }));
  for (const entry of entries) {
    for (const variant of ["esm", "cjs"]) {
      const target = path.join(dependency, "dist", variant, entry);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, variant === "esm" ? "export const ready = true;" : "module.exports = {ready:true};");
    }
  }
  writeFileSync(path.join(dependency, "dist/cjs/package.json"), '{"type":"commonjs"}');
  return { ...f, sdk: dependency, entries };
}

test("Node verifier accepts an exports-only SDK through the ESM subpaths used by serving", () => {
  const f = sdkNodeFixture();
  try {
    const require = createRequire(path.join(f.root, "package.json"));
    assert.throws(() => require.resolve("@modelcontextprotocol/sdk"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    assert.equal(verifyNodeDependencies(f.root), true);
    recordStep("node-deps", { root: f.root });
    assert.equal(stepStatus("node-deps", { root: f.root }), "skip");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Node verifier refuses each missing actual SDK ESM entry even when its CommonJS entry remains usable", () => {
  for (const entry of ["server/index.js", "server/streamableHttp.js", "types.js", "validation/ajv-provider.js"]) {
    const f = sdkNodeFixture();
    try {
      recordStep("node-deps", { root: f.root });
      const require = createRequire(path.join(f.root, "package.json"));
      assert.equal(require(`@modelcontextprotocol/sdk/${entry}`).ready, true);
      rmSync(path.join(f.sdk, "dist/esm", entry));
      assert.equal(existsSync(path.join(f.sdk, "dist/cjs", entry)), true);
      assert.throws(() => verifyNodeDependencies(f.root), /runtime import probe failed: @modelcontextprotocol\/sdk/u);
      assert.equal(stepStatus("node-deps", { root: f.root }), "run");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("Node SDK probe evaluates runtime modules and still enforces the complete locked tree", () => {
  for (const scenario of ["broken import", "mismatched locked package"]) {
    const f = sdkNodeFixture();
    try {
      recordStep("node-deps", { root: f.root });
      if (scenario === "broken import") writeFileSync(path.join(f.sdk, "dist/esm/types.js"), "throw new Error('fixture initialization failed');");
      else writeFileSync(path.join(f.dependency, "package.json"), JSON.stringify({ version: "0.0.0" }));
      assert.throws(() => verifyNodeDependencies(f.root), scenario === "broken import" ? /runtime import probe failed/u : /tree is incomplete or mismatched/u);
      assert.equal(stepStatus("node-deps", { root: f.root }), "run");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});
