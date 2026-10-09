import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eventVerificationScope, verificationScope } from "../scripts/verification-scope.mjs";

test("verification scopes only known documents and proof inputs", () => {
  const evidence = ["README.md", "docs/INSTALL.md", "docs/history/release.json", "v2_agent/README.md", "v2_agent/openrouter/deepseek-v4.1-flash-together/proof.json", "v2_agent/_template/proof.md"];
  assert.equal(verificationScope(evidence), "evidence");
  for (const runtime of ["src/router.mjs", "package.json", "package-lock.json", "requirements/python.txt", "skills/codex-router/SKILL.md", "config/openrouter/pareto.json", "test/router.test.mjs", ".github/workflows/ci.yml", "scripts/verification-scope.mjs", "docs/history/helper.mjs", "unknown.md", "v2_agent/other.json", "AGENTS.md"]) {
    assert.equal(verificationScope([...evidence, runtime]), "full", runtime);
  }
  for (const paths of [[], null, ["docs/../src/file.md"], ["docs\\file.md"], ["docs/line\nfile.md"], ["/docs/file.md"], ["docs//file.md"]]) assert.equal(verificationScope(paths), "full");
});

test("Actions scope fetches missing shallow ancestry once and keeps complete runtime diffs", t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-ci-shallow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source"); mkdirSync(source);
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(source, ["init", "--quiet", "--initial-branch=main"]);
  git(source, ["config", "user.name", "Synthetic fixture"]); git(source, ["config", "user.email", "fixture@example.invalid"]);
  mkdirSync(path.join(source, "src"));
  writeFileSync(path.join(source, "src/runtime.mjs"), "export const n = 1;\n");
  const commit = () => { git(source, ["add", "."]); git(source, ["commit", "--quiet", "-m", "synthetic inputs"]); return git(source, ["rev-parse", "HEAD"]); };
  const base = commit();
  for (let n = 0; n < 3; n++) { writeFileSync(path.join(source, "README.md"), `# Overview ${n}\n`); commit(); }
  const docsHead = git(source, ["rev-parse", "HEAD"]);
  const clone = name => {
    const cwd = path.join(directory, name);
    git(directory, ["clone", "--quiet", "--depth=2", pathToFileURL(source).href, cwd]);
    assert.equal(git(cwd, ["rev-parse", "--is-shallow-repository"]), "true");
    return cwd;
  };
  const cwd = clone("docs");
  const script = fileURLToPath(new URL("../scripts/verification-scope.mjs", import.meta.url));
  const eventPath = path.join(directory, "event.json"), output = path.join(directory, "scope.txt");
  writeFileSync(eventPath, JSON.stringify({ before: base }));
  const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: docsHead, GITHUB_OUTPUT: output };
  const run = flags => {
    const result = spawnSync(process.execPath, [script, ...flags], { cwd, env, encoding: "utf8", windowsHide: true, timeout: 35_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).scope;
  };
  assert.equal(run([]), "full", "ordinary inspection cannot fetch");
  assert.equal(git(cwd, ["rev-parse", "--is-shallow-repository"]), "true");
  assert.equal(run(["--fetch-base"]), "evidence");
  assert.equal(git(cwd, ["rev-parse", "HEAD"]), docsHead);
  assert.equal(git(cwd, ["status", "--porcelain"]), "");
  assert.equal(readFileSync(output, "utf8"), "scope=full\nscope=evidence\n");

  writeFileSync(path.join(source, "src/runtime.mjs"), "export const n = 2;\n"); commit();
  for (let n = 3; n < 6; n++) { writeFileSync(path.join(source, "README.md"), `# Overview ${n}\n`); commit(); }
  const runtimeHead = git(source, ["rev-parse", "HEAD"]), runtimeCwd = clone("runtime");
  assert.equal(eventVerificationScope({ cwd: runtimeCwd, eventName: "push", event: { before: docsHead }, head: runtimeHead, fetchBase: true }).scope, "full", "runtime changes outside the initial shallow slice are retained");
  const unavailable = clone("unavailable");
  git(unavailable, ["remote", "set-url", "origin", pathToFileURL(path.join(directory, "absent")).href]);
  assert.equal(eventVerificationScope({ cwd: unavailable, eventName: "push", event: { before: docsHead }, head: runtimeHead, fetchBase: true }).scope, "full", "failed fetch cannot narrow verification");
});

test("ordinary CI caller uses actual event diffs and defaults ambiguous inputs to full", t => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "router-ci-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  git(["config", "user.name", "Synthetic fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  const commit = () => { git(["add", "."]); git(["commit", "--quiet", "-m", "synthetic inputs"]); return git(["rev-parse", "HEAD"]); };
  mkdirSync(path.join(cwd, "src")); writeFileSync(path.join(cwd, "src/runtime.mjs"), "export const n = 1;\n");
  const base = commit();
  writeFileSync(path.join(cwd, "README.md"), "# Updated overview\n");
  const evidenceHead = commit();
  const scope = (eventName, event, head = evidenceHead) => eventVerificationScope({ cwd, eventName, event, head }).scope;
  assert.equal(scope("push", { before: base }), "evidence");
  for (const before of [undefined, "0".repeat(40), "f".repeat(40), "HEAD~1", "--help"]) assert.equal(scope("push", { before }), "full");
  assert.equal(scope("workflow_dispatch", { before: base }), "full");
  assert.equal(scope("push", { before: base }, base), "full");
  assert.equal(scope("push", { before: evidenceHead }), "full", "empty diff retains full verification");
  writeFileSync(path.join(cwd, "uncommitted.md"), "dirty input");
  assert.equal(scope("push", { before: base }), "full"); rmSync(path.join(cwd, "uncommitted.md"));

  // A real PR merge checkout has the target branch as its first parent.
  git(["checkout", "--quiet", "-b", "topic"]);
  writeFileSync(path.join(cwd, "SECURITY.md"), "# Guidance\n"); commit();
  git(["checkout", "--quiet", "main"]);
  git(["merge", "--quiet", "--no-ff", "topic", "-m", "synthetic PR merge"]);
  const mergeHead = git(["rev-parse", "HEAD"]);
  assert.equal(scope("pull_request", { pull_request: { base: { sha: evidenceHead } } }, mergeHead), "evidence");

  mkdirSync(path.join(cwd, "docs"));
  renameSync(path.join(cwd, "src/runtime.mjs"), path.join(cwd, "docs/moved.md"));
  const movedHead = commit();
  assert.equal(scope("push", { before: mergeHead }, movedHead), "full", "renaming runtime to documents retains the removed runtime path");
  const unrelated = git(["hash-object", "-w", "README.md"]);
  assert.equal(scope("push", { before: unrelated }, movedHead), "full", "a non-commit object is not a usable base");

  // Execute the same command wired into Actions, without modifying the checkout.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "router-ci-event-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const script = path.join(scratch, "scope.mjs"), eventFile = path.join(scratch, "event.json"), output = path.join(scratch, "output.txt");
  copyFileSync(fileURLToPath(new URL("../scripts/verification-scope.mjs", import.meta.url)), script);
  git(["checkout", "--quiet", "--detach", evidenceHead]);
  writeFileSync(eventFile, JSON.stringify({ before: base }));
  const env = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventFile, GITHUB_SHA: evidenceHead, GITHUB_OUTPUT: output };
  const result = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).scope, "evidence");
  assert.equal(readFileSync(output, "utf8"), "scope=evidence\n");
  writeFileSync(eventFile, "malformed JSON");
  const failedEvent = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8", windowsHide: true });
  assert.equal(failedEvent.status, 0, failedEvent.stderr);
  assert.equal(JSON.parse(failedEvent.stdout).scope, "full");
});
