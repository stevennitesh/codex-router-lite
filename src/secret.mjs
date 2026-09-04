import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";

import { protectPrivateFile, writePrivateFile } from "./file-security.mjs";
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

function validSecret(target) {
  if (!existsSync(target)) return false;
  try {
    return generatedSecretPattern.test(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

function ensureSecret(target) {
  if (!validSecret(target)) {
    writePrivateFile(target, `${randomBytes(48).toString("base64url")}\n`);
  }
}

function status(target) {
  const present = validSecret(target);
  if (present) protectPrivateFile(target);
  return { present };
}

if (command === "ensure") {
  ensureSecret(INTERNAL_SECRET_PATH);
  ensureSecret(CALLER_SECRET_PATH);
}

const internal = status(INTERNAL_SECRET_PATH);
const caller = status(CALLER_SECRET_PATH);
process.stdout.write(
  `${JSON.stringify({
    present: internal.present && caller.present,
    internal,
    caller,
  })}\n`,
);
if (!internal.present || !caller.present) process.exitCode = 1;
