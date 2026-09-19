import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { auditDependencies } from "../scripts/audit-dependencies.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const report = (high = 0, critical = 0) => ({ status: high || critical ? 1 : 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { high, critical } } }) });
const unavailable = { status: 1, stdout: JSON.stringify({ error: { code: "E503" } }) };

async function auditSequence(results) {
  let calls = 0;
  const delays = [];
  const status = await auditDependencies({ npmCli: "fixture npm-cli.js", log() {}, sleep: async (ms) => delays.push(ms), run: (exe, args, options) => {
    assert.equal(exe, process.execPath);
    assert.deepEqual(args, ["fixture npm-cli.js", "audit", "--omit=dev", "--audit-level=high", "--json"]);
    assert.equal(options.timeout, 60_000);
    return results[Math.min(calls++, results.length - 1)];
  } });
  return { status, calls, delays };
}

test("audit retries registry outages, but never converts exhaustion to success", async () => {
  assert.deepEqual(await auditSequence([unavailable, report()]), { status: 0, calls: 2, delays: [5000] });
  assert.deepEqual(await auditSequence([unavailable]), { status: 1, calls: 3, delays: [5000, 10000] });
  assert.equal((await auditSequence([{ status: null, error: { code: "ETIMEDOUT" } }, report()])).status, 0);
});

test("audit blocks vulnerabilities and unknown errors without retrying", async () => {
  for (const result of [report(1), report(0, 1), { ...report(1), stderr: "E503" }, { status: 0, stdout: "{}" }, { status: 1, stdout: "garbage E503" }, { status: 1, stdout: JSON.stringify({ error: { code: "E401" } }) }, { ...report(), status: 1 }]) {
    assert.deepEqual(await auditSequence([result]), { status: 1, calls: 1, delays: [] });
  }
});

test("audit invokes a real CLI path containing spaces without shell interpretation", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "router audit "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "npm fixture.cjs");
  writeFileSync(cli, `require('node:assert/strict').deepEqual(process.argv.slice(2), ['audit', '--omit=dev', '--audit-level=high', '--json']); console.log(${JSON.stringify(report().stdout)});`);
  assert.equal(await auditDependencies({ npmCli: cli, log() {} }), 0);
});

test("product boundary sees new files before staging, skips ignored files, and still checks tracked ignored files", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "router-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(path.join(root, "maintenance/windows-package.json"), "utf8"));
  for (const file of [...new Set([...manifest.files, "scripts/check-product-boundary.mjs"])]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  const check = () => spawnSync(process.execPath, ["scripts/check-product-boundary.mjs"], { cwd: dir, encoding: "utf8" });
  assert.equal(check().status, 0);
  mkdirSync(path.join(dir, "hooks"));
  writeFileSync(path.join(dir, "hooks/new.txt"), "forbidden");
  assert.match(check().stderr, /forbidden product artifact: hooks\/new.txt/u);
  writeFileSync(path.join(dir, ".gitignore"), "hooks/\n");
  assert.equal(check().status, 0);
  execFileSync("git", ["add", "--force", "hooks/new.txt"], { cwd: dir });
  assert.match(check().stderr, /forbidden product artifact: hooks\/new.txt/u);
});
