import { realpathSync } from "node:fs";
import path from "node:path";

import { readInstallManifestDetail } from "./install-manifest.mjs";
import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";

// One state directory is owned by exactly one checkout. A second checkout can
// still read it, but writing the generated catalog or gateway config from there
// silently desynchronizes the two: the running service keeps serving routes
// from its own registry while Codex is handed a catalog built from a different
// one, so the picker advertises models the gateway cannot route.
//
// install.ps1 is the sanctioned ownership transfer. It sets the override below
// because it regenerates state before recording the new owner.
const OVERRIDE_ENV = "MODEL_ROUTER_ALLOW_FOREIGN_STATE";

function canonical(directory) {
  if (typeof directory !== "string" || !directory) return undefined;
  const resolved = path.resolve(directory);
  try {
    return realpathSync(resolved);
  } catch {
    // A recorded root that no longer exists still compares usefully as a path.
    return resolved;
  }
}

function stateOwnershipStatus() {
  const current = canonical(SOURCE_ROOT);
  const record = readInstallManifestDetail();
  const recorded = record.manifest?.current?.sourceRoot;
  const validOwner = recorded === undefined || recorded === "" ||
    (typeof recorded === "string" && path.isAbsolute(recorded));
  const owner = canonical(recorded);
  return {
    stateDir: STATE_DIR,
    current,
    owner,
    recordStatus: validOwner ? record.status : "invalid-owner",
    indeterminate: !["missing", "present"].includes(record.status) || !validOwner,
    // Unowned state (a fresh or hand-made directory) belongs to whoever writes
    // it first; only a recorded, different owner is a conflict.
    foreign: Boolean(owner && current && owner !== current),
    overridden: process.env[OVERRIDE_ENV] === "1",
  };
}

function stateOwnershipMessage(operation, status) {
  return [
    `Refusing to ${operation}: ${status.stateDir} is owned by another checkout.`,
    `  owner:   ${status.owner}`,
    `  current: ${status.current}`,
    "Writing generated state from a second checkout makes Codex advertise",
    "models the running gateway cannot route. Run `.\\model-router.ps1 codex",
    "doctor` from the recorded owner checkout, then reinstall from there to",
    "repair without changing ownership. To deliberately transfer",
    `ownership to this checkout, reinstall from here or set ${OVERRIDE_ENV}=1.`,
  ].join("\n");
}

export function assertStateOwnership(operation) {
  const status = stateOwnershipStatus();
  if (status.overridden) return status;
  if (status.indeterminate) {
    const error = new Error(
      `Refusing to ${operation}: ownership of ${status.stateDir} cannot be established (${status.recordStatus}). ` +
      "Read the installation manifest from its owning Windows user and restore a valid record before retrying. " +
      "Use the installer only for an intentional ownership transfer.",
    );
    error.code = "indeterminate_state_owner";
    throw error;
  }
  if (!status.foreign) return status;
  const error = new Error(stateOwnershipMessage(operation, status));
  error.code = "foreign_state_owner";
  throw error;
}
