import assert from "node:assert/strict";
import test from "node:test";

import { probeRegularFile, readJsonFile } from "../src/file-probe.mjs";
import { credentialStatus } from "../src/provider-credentials.mjs";

const fileStat = { isFile: () => true, isSymbolicLink: () => false };

test("JSON reads distinguish confirmed absence, schema input, corruption and inaccessible existing files", () => {
  const unread = () => { throw new Error("must not read absent/non-file input"); };
  for (const status of ["missing", "invalid", "access-denied", "probe-failed"]) {
    assert.deepEqual(readJsonFile("fixture", { probe: () => ({ status }), read: unread }), { status });
  }
  const probe = () => ({ status: "present" });
  assert.deepEqual(readJsonFile("fixture", { probe, read: () => '{"version":1}' }), { status: "present", value: { version: 1 } });
  assert.deepEqual(readJsonFile("fixture", { probe, read: () => '{"private-canary":' }), { status: "invalid" });
  for (const [code, status] of [["EACCES", "access-denied"], ["EPERM", "access-denied"], ["EIO", "probe-failed"], ["ENOENT", "probe-failed"]]) {
    const result = readJsonFile("fixture", { probe, read: () => { throw Object.assign(new Error("private-canary"), { code }); } });
    assert.deepEqual(result, { status, code });
    assert.ok(!JSON.stringify(result).includes("private-canary"));
  }
});

test("file probes distinguish missing and access-denied paths", () => {
  assert.deepEqual(probeRegularFile("missing", { lstat: () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } }), { status: "missing", code: "ENOENT" });
  assert.deepEqual(probeRegularFile("denied", { lstat: () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  } }), { status: "access-denied", code: "EACCES" });
  assert.deepEqual(probeRegularFile("present", { lstat: () => fileStat }), { status: "present" });
});

test("credential status reports an unreadable protected file instead of not configured", () => {
  const status = credentialStatus("openrouter", {
    persistent: true,
    lstat: () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    },
  });
  assert.equal(status.configured, false);
  assert.equal(status.fileStatus, "access-denied");
  assert.equal(status.code, "EPERM");
});
