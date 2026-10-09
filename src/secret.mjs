import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { protectPrivateFile, writePrivateFile } from "./file-security.mjs";
import { fileProbeErrorReason, probeRegularFile } from "./file-probe.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
} from "./paths.mjs";

const command = process.argv[2] || "status";
const generatedSecretPattern = /^[A-Za-z0-9_-]{32,}$/;
if (!new Set(["ensure", "status"]).has(command)) {
  console.error("Usage: secret.mjs ensure|status");
  process.exit(2);
}

function secretStatus(target) {
  const probe = probeRegularFile(target);
  if (probe.status !== "present") return { present: false, fileStatus: probe.status, ...(probe.code ? { code: probe.code } : {}) };
  try {
    const present = generatedSecretPattern.test(readFileSync(target, "utf8").trim());
    return { present, fileStatus: present ? "present" : "invalid" };
  } catch (error) {
    const reason = fileProbeErrorReason(error);
    return { present: false, fileStatus: reason === "missing" ? "probe-failed" : reason, ...(error?.code ? { code: error.code } : {}) };
  }
}

try {
  const targets = [INTERNAL_SECRET_PATH, CALLER_SECRET_PATH];
  if (command === "ensure") {
    // Establish both generations before any mutation. An unreadable caller key
    // must not cause even a missing internal key to be initialized first.
    const statuses = targets.map(secretStatus);
    for (let index = 0; index < targets.length; index += 1) {
      const status = statuses[index];
      if (!["present", "missing"].includes(status.fileStatus)) {
        throw new Error(
          `Refusing to initialize router capabilities: ${targets[index]} is ${status.fileStatus}${status.code ? ` (${status.code})` : ""}. ` +
          "Restore a known-good key or resolve its access problem before retrying. Existing keys are never regenerated implicitly.",
        );
      }
    }
    for (let index = 0; index < targets.length; index += 1) {
      if (statuses[index].fileStatus === "missing") {
        writePrivateFile(targets[index], `${randomBytes(48).toString("base64url")}\n`);
      } else {
        protectPrivateFile(targets[index]);
      }
    }
  }
  const [internal, caller] = targets.map(secretStatus);
  process.stdout.write(`${JSON.stringify({ present: internal.present && caller.present, internal, caller })}\n`);
  if (!internal.present || !caller.present) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
