import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { validServiceSecret } from "./caller-auth.mjs";
import { protectPrivateFile, writePrivateFile } from "./file-security.mjs";
import { fileProbeErrorReason, probeRegularFile } from "./file-probe.mjs";
import { withCallerKeyRotationLock } from "./caller-key-rotation-lock.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
} from "./paths.mjs";

const command = process.argv[2] || "status";
if (!new Set(["ensure", "status"]).has(command)) {
  console.error("Usage: secret.mjs ensure|status");
  process.exit(2);
}

function secretStatus(target) {
  const probe = probeRegularFile(target);
  if (probe.status !== "present") return { present: false, fileStatus: probe.status, ...(probe.code ? { code: probe.code } : {}) };
  try {
    const present = validServiceSecret(readFileSync(target, "utf8").trim());
    return { present, fileStatus: present ? "present" : "invalid" };
  } catch (error) {
    const reason = fileProbeErrorReason(error);
    return { present: false, fileStatus: reason === "missing" ? "probe-failed" : reason, ...(error?.code ? { code: error.code } : {}) };
  }
}

const targets = [INTERNAL_SECRET_PATH, CALLER_SECRET_PATH];
function reportStatus() {
  const [internal, caller] = targets.map(secretStatus);
  process.stdout.write(`${JSON.stringify({ present: internal.present && caller.present, internal, caller })}\n`);
  if (!internal.present || !caller.present) process.exitCode = 1;
}

try {
  if (command === "ensure") await withCallerKeyRotationLock(() => {
    const stateDir = path.dirname(CALLER_SECRET_PATH);
    const journal = probeRegularFile(path.join(stateDir, "caller-key-rotation.json"));
    if (journal.status !== "missing") {
      throw new Error("Caller capability rotation recovery is pending or its journal is inaccessible; recover it before initializing capabilities.");
    }
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
    if (statuses[1].fileStatus === "missing" && readdirSync(stateDir).some(name =>
      ["rollback", "displaced", "new"].some(kind => name.startsWith(`${path.basename(CALLER_SECRET_PATH)}.rotate-${kind}.`)))) {
      throw new Error("Caller capability rotation generations remain without a live capability; recover them before initializing capabilities.");
    }
    for (let index = 0; index < targets.length; index += 1) {
      if (statuses[index].fileStatus === "missing") {
        writePrivateFile(targets[index], `${randomBytes(48).toString("base64url")}\n`);
      } else {
        protectPrivateFile(targets[index]);
      }
    }
    reportStatus();
  }, { stateDir: path.dirname(CALLER_SECRET_PATH) });
  else reportStatus();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
