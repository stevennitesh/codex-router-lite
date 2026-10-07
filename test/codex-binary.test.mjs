import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexAuthStatus,
  codexBinaryFingerprint,
  codexExecutableIdentity,
  assertCodexExecutableIdentity,
  newestCodexBinary,
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
