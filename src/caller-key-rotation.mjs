import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { createPrivateFile, privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { probeRegularFile } from "./file-probe.mjs";

function assertOperationId(operationId) {
  const value = String(operationId || "");
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("Caller capability rotation requires a valid operation id.");
  }
  return value;
}

export function callerCapabilityBackupPath(secretPath, operationId) {
  return `${secretPath}.rotate-rollback.${assertOperationId(operationId)}`;
}

function callerCapabilityTemporaryPath(secretPath, operationId) {
  return `${secretPath}.rotate-new.${assertOperationId(operationId)}`;
}

function callerCapabilityDisplacedPath(secretPath, operationId) {
  return `${secretPath}.rotate-displaced.${assertOperationId(operationId)}`;
}

function digest(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

function readGeneration(target, secretIsProtected) {
  const probe = probeRegularFile(target);
  if (probe.status === "missing") return undefined;
  if (probe.status !== "present") throw new Error(`Caller capability generation is ${probe.status}; refusing recovery.`);
  if (!secretIsProtected(target)) throw new Error("Caller capability generation is not private; refusing recovery.");
  const secret = assertCallerSecret(readFileSync(target, "utf8").trim());
  return { path: target, secret, sha256: digest(secret) };
}

function generations({ secretPath, operationId }, secretIsProtected) {
  return Object.fromEntries(Object.entries({
    live: secretPath,
    backup: callerCapabilityBackupPath(secretPath, operationId),
    displaced: callerCapabilityDisplacedPath(secretPath, operationId),
    temporary: callerCapabilityTemporaryPath(secretPath, operationId),
  }).map(([kind, target]) => [kind, readGeneration(target, secretIsProtected)]));
}

// Classification precedes any service effect. Auxiliary files never establish
// the prior identity, even when their bytes happen to match its digest.
export function inspectCallerCapabilityRollback({
  secretPath, operationId, previousSecretSha256, currentSecretSha256,
  secretIsProtected = privateFileIsProtected,
} = {}) {
  const state = generations({ secretPath, operationId }, secretIsProtected);
  const prior = previousSecretSha256 || state.backup?.sha256;
  if (state.backup && state.backup.sha256 !== prior) {
    throw new Error("Pending caller rotation rollback generation does not match its protected journal; refusing recovery.");
  }
  if (state.live?.sha256 !== prior) {
    if (!state.backup) throw new Error("Pending caller rotation has no rollback generation matching the live capability; refusing recovery.");
    if (state.live && currentSecretSha256 && state.live.sha256 !== currentSecretSha256) {
      throw new Error("Pending caller rotation live capability matches neither journal generation; refusing recovery.");
    }
    if (state.live && state.displaced) {
      throw new Error("Caller capability rollback has an occupied displaced generation; refusing recovery.");
    }
  }
  const rollbackSecret = state.live?.sha256 === prior ? state.live.secret : state.backup?.secret;
  if (!rollbackSecret) throw new Error("Pending caller rotation has no proven prior capability; refusing recovery.");
  // A journal-bound auxiliary or a live key we are about to supersede gives
  // verification an actual stale identity. Unbound retained files do not.
  const superseded = state.live && state.live.sha256 !== prior ? state.live :
    [state.displaced, state.temporary].find(value => currentSecretSha256 && value?.sha256 === currentSecretSha256);
  return { ...state, rollbackSecret, displacedSecret: superseded?.secret };
}

export function discardCallerCapabilityRetiredGenerations({
  secretPath, journal, committed = false, secretIsProtected = privateFileIsProtected,
} = {}) {
  const options = { secretPath, operationId: journal.operationId };
  const state = generations(options, secretIsProtected);
  const expectedLive = committed ? journal.currentSecretSha256 : journal.previousSecretSha256;
  if (!expectedLive || state.live?.sha256 !== expectedLive) {
    throw new Error("Caller rotation live capability does not match its protected journal; refusing cleanup.");
  }
  if (state.backup && state.backup.sha256 !== journal.previousSecretSha256) {
    throw new Error("Caller rotation rollback generation changed; refusing cleanup.");
  }
  const retired = [state.backup, ...[state.displaced, state.temporary].filter(value =>
    value && journal.currentSecretSha256 && value.sha256 === journal.currentSecretSha256)].filter(Boolean);
  for (const generation of retired) {
    const current = readGeneration(generation.path, secretIsProtected);
    if (current && current.sha256 !== generation.sha256) throw new Error("Caller rotation retired generation changed; refusing cleanup.");
    if (current) unlinkSync(generation.path);
  }
}

function removeIfPresent(target) {
  if (existsSync(target)) unlinkSync(target);
}

function combinedFailure(error, rollbackError) {
  if (!rollbackError) return error;
  return new Error(
    `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
    { cause: error },
  );
}

export function swapCallerCapability({
  secretPath,
  operationId,
  generateSecret = () => randomBytes(48).toString("base64url"),
  protect = protectPrivateFile,
} = {}) {
  const previousSecret = assertCallerSecret(readFileSync(secretPath, "utf8").trim());
  const currentSecret = assertCallerSecret(String(generateSecret()).trim());
  if (currentSecret === previousSecret) throw new Error("Caller capability rotation generated the existing key.");

  const temporary = callerCapabilityTemporaryPath(secretPath, operationId);
  const backup = callerCapabilityBackupPath(secretPath, operationId);
  if (existsSync(temporary) || existsSync(backup)) throw new Error("Caller capability rotation generation already exists; recover it before retrying.");
  createPrivateFile(temporary, `${currentSecret}\n`, { protect });

  let backupPresent = false;
  let newSecretLive = false;
  try {
    renameSync(secretPath, backup);
    backupPresent = true;
    protect(backup);
    renameSync(temporary, secretPath);
    newSecretLive = true;
    protect(secretPath);
    return { previousSecret, currentSecret, backupPath: backup };
  } catch (error) {
    let rollbackError;
    try {
      if (newSecretLive) removeIfPresent(secretPath);
      if (backupPresent && existsSync(backup)) {
        renameSync(backup, secretPath);
        backupPresent = false;
        protect(secretPath);
      }
    } catch (caught) {
      rollbackError = caught;
    }
    removeIfPresent(temporary);
    throw combinedFailure(error, rollbackError);
  } finally {
    removeIfPresent(temporary);
  }
}

export function restoreCallerCapability({
  secretPath, operationId, protect = protectPrivateFile,
  previousSecretSha256, currentSecretSha256, secretIsProtected = privateFileIsProtected,
} = {}) {
  const backup = callerCapabilityBackupPath(secretPath, operationId);
  if (!previousSecretSha256 && !existsSync(backup)) return { restored: false };
  const state = inspectCallerCapabilityRollback({ secretPath, operationId, previousSecretSha256, currentSecretSha256, secretIsProtected });
  if (state.live?.secret === state.rollbackSecret) {
    return { restored: false, currentSecret: state.rollbackSecret, displacedSecret: state.displacedSecret, retainedGenerations: state };
  }
  const displaced = callerCapabilityDisplacedPath(secretPath, operationId);
  let displacedPresent = false;
  let backupMoved = false;
  try {
    if (state.live) {
      renameSync(secretPath, displaced);
      displacedPresent = true;
      protect(displaced);
    }
    renameSync(backup, secretPath);
    backupMoved = true;
    protect(secretPath);
    const currentSecret = assertCallerSecret(readFileSync(secretPath, "utf8").trim());
    return { restored: true, currentSecret, displacedSecret: state.displacedSecret, retainedGenerations: state };
  } catch (error) {
    let rollbackError;
    try {
      if (backupMoved && existsSync(secretPath)) {
        renameSync(secretPath, backup);
        backupMoved = false;
        protect(backup);
      }
      if (displacedPresent && existsSync(displaced)) {
        renameSync(displaced, secretPath);
        displacedPresent = false;
        protect(secretPath);
      }
    } catch (caught) {
      rollbackError = caught;
    }
    throw combinedFailure(error, rollbackError);
  }
}

export function discardCallerCapabilityBackup({ secretPath, operationId } = {}) {
  const backup = callerCapabilityBackupPath(secretPath, operationId);
  if (!existsSync(backup)) return false;
  unlinkSync(backup);
  return true;
}
