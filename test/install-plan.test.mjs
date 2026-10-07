import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pythonLockDrift, pythonRequirements, recordStep, stepStatus } from "../src/install-plan.mjs";

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
    writeFileSync(path.join(requirements, "python.txt"), `# uv pip compile --python-platform windows --generate-hashes\nlitellm==${version} --hash=sha256:${"a".repeat(64)}\nfastapi==0.141.1 --hash=sha256:${"b".repeat(64)}\n`);
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

test("a matching stamp never skips a broken Python runtime or missing interpreter home", () => {
  const f = fixture();
  try {
    recordStep("python-deps", { root: f.root });
    assert.equal(stepStatus("python-deps", { root: f.root, platform: "win32", runtimeProblem: () => "broken stdlib" }), "run");
    writeFileSync(path.join(f.root, ".venv/pyvenv.cfg"), `home = ${path.join(f.root, "missing")}\nversion = 3.12.12\n`);
    assert.equal(stepStatus("python-deps", { root: f.root, platform: "win32", runtimeProblem: () => undefined }), "run");
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
