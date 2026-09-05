import assert from "node:assert/strict";
import test from "node:test";

import { probeRegularFile } from "../src/file-probe.mjs";
import { credentialStatus } from "../src/provider-credentials.mjs";

const fileStat = { isFile: () => true, isSymbolicLink: () => false };

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
