import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredEntrypoints = [
  "install.ps1",
  "model-router.ps1",
  "deploy-codex-router.ps1",
  "restart-codex-router.ps1",
  "src/start.mjs",
  "src/router.mjs",
  "src/api-forwarder.mjs",
  "src/control.mjs",
  "src/config-manager.mjs",
  "src/doctor.mjs",
];
const retainedConfig = [
  "config/openrouter/glm-5.3-flash-gmicloud.json",
  "config/openrouter/glm-5.3-flash.json",
  "config/openrouter/openrouter.json",
  "config/openrouter/pareto.json",
  "config/switchyard/auto.json",
  "config/switchyard/switchyard.json",
];
const forbiddenPaths = [
  /^\.github\/workflows\/release\.yml$/u,
  /^docs-site\//u,
  /^bin\//u,
  /^hooks\//u,
  /^src\/compat\//u,
  /^docs\/research\//u,
  /^maintenance\/retained-/u,
  /^scripts\/(?:capture-|run-retained-tests|aging-|live-test-|measure-)/u,
  /^scripts\/(?:verify-python-lock\.py|verify-skill-injection\.mjs)$/u,
  /^src\/(?:deepseek-tool-message-compat|direct-image-policy|login-free-|native-alias|native-client-models|native-context-variants|request-profiles|route-failure-policy|usage-events)\.mjs$/u,
  /^src\/(?:native-redirect|subagent-routing|tool-result-aging|tool-result-aging-state|tool-result-retention)\.mjs$/u,
  /^src\/codex-session-names\.mjs$/u,
  /^docs\/(?:DEVELOPMENT|HOW-IT-WORKS)\.md$/u,
  /^skills\/codex-router-media\//u,
];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => existsSync(path.join(root, file)));

for (const file of requiredEntrypoints) {
  assert.ok(existsSync(path.join(root, file)), `missing retained entrypoint: ${file}`);
}
for (const dispatcher of ["src/start.mjs", "install.ps1", "model-router.ps1", "deploy-codex-router.ps1", "restart-codex-router.ps1"]) {
  const source = readFileSync(path.join(root, dispatcher), "utf8");
  for (const match of source.matchAll(/src[\\/]([A-Za-z0-9_.-]+\.mjs)/gu)) {
    const target = `src/${match[1]}`;
    assert.ok(existsSync(path.join(root, target)), `${dispatcher} references missing ${target}`);
  }
}
for (const file of tracked) {
  assert.ok(!forbiddenPaths.some((pattern) => pattern.test(file)), `forbidden product artifact: ${file}`);
}

const actualConfig = [];
for (const provider of ["openrouter", "switchyard"]) {
  for (const name of readdirSync(path.join(root, "config", provider))) {
    if (name.endsWith(".json")) actualConfig.push(`config/${provider}/${name}`);
  }
}
assert.deepEqual(actualConfig.sort(), retainedConfig, "routed JSON config must contain only GLM, Pareto, and Switchyard");

const packageManifest = JSON.parse(
  readFileSync(path.join(root, "maintenance", "windows-package.json"), "utf8"),
);
const nodeManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(nodeManifest.name, "codex-router-lite", "private package identity drifted");
assert.equal(packageManifest.version, 1);
assert.equal(new Set(packageManifest.files).size, packageManifest.files.length, "duplicate package path");
for (const file of packageManifest.files) {
  assert.ok(existsSync(path.join(root, file)), `package file is missing: ${file}`);
  assert.ok(
    !/^(?:\.github|docs|generated|test|scripts)(?:\/|$)/u.test(file),
    `development-only file is packaged: ${file}`,
  );
}
for (const file of [
  ...requiredEntrypoints,
  ...retainedConfig,
  "LICENSE",
  "LICENSES/Apache-2.0.txt",
  "NOTICE.md",
  "config/switchyard/patches/README.md",
]) {
  assert.ok(packageManifest.files.includes(file), `retained package file is absent: ${file}`);
}

const runtimeFiles = tracked.filter(
  (file) => file.startsWith("src/") || /^(?:install|deploy-codex-router|restart-codex-router)\.ps1$/u.test(file),
);
const forbiddenRuntimeText = [
  ["/dev/tty", "POSIX terminal input"],
  ["/bin/stty", "POSIX terminal control"],
  ['"which"', "POSIX PATH lookup"],
  [".local\\share\\codex-router", "non-Windows install root"],
  ['".local", "bin"', "non-Windows Codex binary path"],
  ["chmodSync", "POSIX permission mutation"],
  ["mode: 0o", "POSIX permission mode"],
  ["legacyPort", "retired caller-port compatibility"],
  ["LaunchAgent", "non-Windows service terminology"],
  ["Control Center", "retired Router UI terminology"],
  ["bin/install", "retired installer terminology"],
  ["support-bundle.mjs", "retired support-bundle reference"],
  ["the Dock", "non-Windows desktop terminology"],
];
for (const file of runtimeFiles) {
  const source = readFileSync(path.join(root, file), "utf8");
  for (const [marker, family] of forbiddenRuntimeText) {
    assert.ok(!source.includes(marker), `${file} restored ${family}`);
  }
}

console.log(`product boundary passed (${tracked.length} tracked files, ${packageManifest.files.length} packaged files)`);
