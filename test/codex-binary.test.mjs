import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import {
  codexAuthStatus,
  codexBinaryFingerprint,
  codexExecutableIdentity,
  assertCodexExecutableIdentity,
  newestCodexBinary,
  newestCodexBinaryAsync,
  findCodexBinaryAsync,
} from "../src/codex-binary.mjs";

test("equal-version Codex app binaries select the newest installed build", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-binary-"));
  const oldBinary = path.join(testRoot, "old.exe");
  const newBinary = path.join(testRoot, "new.exe");
  writeFileSync(oldBinary, "old");
  writeFileSync(newBinary, "new");
  try {
    assert.equal(
      newestCodexBinary(
        [oldBinary, newBinary],
        () => "codex-cli 1.2.3",
        (candidate) => candidate === newBinary ? 2 : 1,
      ),
      newBinary,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("async Codex selection retains version, prerelease, mtime, and missing-version policies", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-async-binary-"));
  const binaries = ["a", "b", "c"].map((name) => path.join(root, `${name}.exe`));
  for (const binary of binaries) writeFileSync(binary, "fixture");
  try {
    for (const versions of [
      ["codex-cli 1.2.3", "codex-cli 1.2.4-alpha.2", "codex-cli 1.2.4"],
      ["codex-cli 1.2.4-alpha.9", "codex-cli 1.2.4-alpha.10", "codex-cli 1.2.3"],
      ["codex-cli 1.2.3", "codex-cli 1.2.3", "codex-cli 1.2.3"],
      [undefined, "codex-cli 1.2.3", undefined],
      [undefined, undefined, undefined],
    ]) {
      const versionFor = (binary) => versions[binaries.indexOf(binary)];
      const modifiedFor = (binary) => [1, 3, 2][binaries.indexOf(binary)];
      const candidates = [path.join(root, "missing.exe"), ...binaries, binaries[0]];
      assert.equal(await newestCodexBinaryAsync(candidates, async (binary) => versionFor(binary), modifiedFor),
        newestCodexBinary(candidates, versionFor, modifiedFor));
    }
    assert.equal(await newestCodexBinaryAsync([]), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("async discovery keeps explicit choice and leaves the event loop responsive during PATH/version probes", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-discover-async-"));
  const binary = path.join(root, "codex.exe");
  writeFileSync(binary, "fixture");
  const saved = Object.fromEntries(["CODEX_BIN", "CODEX_INSTALL_DIR", "LOCALAPPDATA"].map((name) => [name, process.env[name]]));
  const commands = [];
  t.mock.method(childProcess, "execFile", (command, args, _options, callback) => {
    commands.push({ command, args });
    setTimeout(() => callback(null, command === "where.exe" ? binary : "codex-cli 1.2.3"), 80);
  });
  syncBuiltinESMExports();
  try {
    process.env.CODEX_BIN = binary;
    assert.equal(await findCodexBinaryAsync(), binary);
    assert.equal(commands.length, 0, "explicit configured executable bypasses discovery");
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_INSTALL_DIR;
    process.env.LOCALAPPDATA = root;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      assert.equal(await findCodexBinaryAsync(), binary);
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 5, "both slow subprocess probes allow unrelated event-loop work");
    assert.deepEqual(commands, [{ command: "where.exe", args: ["codex"] }, { command: binary, args: ["--version"] }]);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operation identity discovers once and retains the selected producer without caching later operations", () => {
  let discoveries = 0, versions = 0;
  const options = {
    findBinary: () => `C:\\fixture\\codex-${++discoveries}.exe`,
    versionFor: () => { versions++; return "codex-cli 1.2.3"; },
    fingerprintFor: binary => `fingerprint:${binary}`,
  };
  const first = codexExecutableIdentity(options);
  assert.equal(discoveries, 1);
  assert.equal(versions, 1);
  assert.equal(Object.isFrozen(first), true);
  const auth = codexAuthStatus({ binary: first.binary,
    findBinary: () => { throw new Error("must not rediscover"); },
    execute: (_command, args) => assert.deepEqual(args, ["login", "status"]),
  });
  assert.equal(auth.binary, first.binary);
  const second = codexExecutableIdentity(options);
  assert.equal(discoveries, 2);
  assert.notEqual(second.binary, first.binary);
});

test("operation identity rejects executable drift and preserves unavailable version as unknown", () => {
  let fingerprint = "before";
  assert.throws(() => codexExecutableIdentity({findBinary: () => "C:\\fixture\\codex.exe",
    fingerprintFor: () => fingerprint,
    versionFor: () => { fingerprint = "after"; return "codex-cli 1.2.3"; },
  }), {code:"codex_binary_changed"});
  const identity = codexExecutableIdentity({findBinary: () => "C:\\fixture\\codex.exe",
    fingerprintFor: () => "unchanged", versionFor: () => undefined,
  });
  assert.equal(identity.version, undefined);
  assert.throws(() => assertCodexExecutableIdentity(identity, {fingerprintFor: () => undefined}), {code:"codex_binary_changed"});
  assert.deepEqual(codexExecutableIdentity({findBinary: () => undefined}), {binary:undefined,version:undefined,fingerprint:undefined});
});

test("Codex binary identity changes for a same-version runtime replacement", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-binary-identity-"));
  const binary = path.join(testRoot, "codex.exe");
  try {
    writeFileSync(binary, "first runtime");
    const before = codexBinaryFingerprint(binary);
    writeFileSync(binary, "replacement runtime with different bytes");
    const after = codexBinaryFingerprint(binary);
    assert.match(before, /^[a-f0-9]{64}$/u);
    assert.match(after, /^[a-f0-9]{64}$/u);
    assert.notEqual(after, before);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Codex authentication distinguishes signed-out, access, and unknown failures", () => {
  const failure = (message, properties = {}) => () => {
    throw Object.assign(new Error(message), properties);
  };
  const options = { findBinary: () => "C:\\fixture\\codex.exe" };
  assert.equal(codexAuthStatus({ ...options, execute: failure("Not logged in", { status: 1 }) }).reason, "signed-out");
  assert.equal(codexAuthStatus({ ...options, execute: failure("Access is denied", { status: 1 }) }).reason, "access-denied");
  assert.equal(codexAuthStatus({ ...options, execute: failure("unexpected", { status: 1 }) }).reason, "probe-failed");
});
