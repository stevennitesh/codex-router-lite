import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readInstallManifest } from "./install-manifest.mjs";
import { SOURCE_ROOT } from "./paths.mjs";

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", SOURCE_ROOT, ...args], {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

export function recognizedRepositoryUrl(origin, configured = process.env.CODEX_ROUTER_REPOSITORY_URL) {
  const allowed = new Set([
    configured,
    "https://github.com/stevennitesh/codex-router-lite",
    "https://github.com/stevennitesh/codex-router-lite.git",
    "git@github.com:stevennitesh/codex-router-lite.git",
  ].filter(Boolean));
  return allowed.has(origin);
}

function requireManagedCheckout() {
  if (!existsSync(path.join(SOURCE_ROOT, ".git"))) {
    throw new Error(
      "This release is not a Git checkout. Re-run the installation command to upgrade it.",
    );
  }
  const origin = git(["remote", "get-url", "origin"]);
  if (!recognizedRepositoryUrl(origin)) {
    throw new Error(`The origin remote is not a recognized Codex Router repository: ${origin}`);
  }
}

// Exported so the Windows bootstrap installer, which reimplements this refusal
// in PowerShell and cannot import it, can be tested against the same number.
export const DIRTY_PREVIEW_LIMIT = 10;

// Only tracked edits are at stake. A fast-forward merge never replaces an
// untracked file, and git refuses the rare collision on its own with a precise
// message, so counting untracked files as "local changes" only ever stranded
// people: one stray file in the checkout and every future update was refused,
// with nothing in the error to say which file or how to get past it.
function localModifications() {
  return git(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function localModificationsMessage(changes, sourceRoot = SOURCE_ROOT) {
  const preview = changes
    .slice(0, DIRTY_PREVIEW_LIMIT)
    .map((line) => `  ${line}`)
    .join("\n");
  const remainder = changes.length - DIRTY_PREVIEW_LIMIT;
  return [
    `The checkout has local changes to ${changes.length} tracked file${
      changes.length === 1 ? "" : "s"
    }; refusing to replace them during update:`,
    preview,
    ...(remainder > 0 ? [`  ...and ${remainder} more`] : []),
    "",
    `Keep them:    git -C ${sourceRoot} stash`,
    "Discard them: re-run the same command with --force",
  ].join("\n");
}

// Called only where the checkout is actually about to be rewritten, so a
// checkout with edits still answers "is an update available?" and still
// reinstalls at the same commit.
function requireReplaceableCheckout(force) {
  const changes = localModifications();
  if (changes.length === 0) return;
  if (!force) throw new Error(localModificationsMessage(changes));
  git(["reset", "--hard", "HEAD"], { inherit: true });
}

export function currentCheckoutInstaller(
  platform = process.platform,
  target = "codex",
) {
  if (platform !== "win32") {
    throw new Error(`Unsupported installer platform: ${platform}`);
  }
  if (target !== "codex") {
    throw new Error(`Unsupported client target: ${target}`);
  }
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(SOURCE_ROOT, "install.ps1"),
      "-CheckoutInstall",
      "-Target",
      "codex",
    ],
  };
}

function installCurrentCheckout(forceServiceReplacement = false) {
  const installer = currentCheckoutInstaller();
  if (forceServiceReplacement) installer.args.push("-ForceServiceReplacement");
  const result = spawnSync(installer.command, installer.args, {
    cwd: SOURCE_ROOT,
    stdio: "inherit",
    env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Installer exited with status ${result.status}.`);
  }
}

function revisionExists(revision) {
  try {
    git(["cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function revisionIsAncestor(ancestor, descendant) {
  const result = spawnSync(
    "git",
    ["-C", SOURCE_ROOT, "merge-base", "--is-ancestor", ancestor, descendant],
    { stdio: "ignore", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Unable to compare Git revisions ${ancestor} and ${descendant}.`);
}

export function classifyUpdateRelation(current, available, isAncestor) {
  if (current === available) return "synchronized";
  if (isAncestor(current, available)) return "remote-ahead";
  if (isAncestor(available, current)) return "local-ahead";
  return "diverged";
}

function restoreRevision(revision, forceServiceReplacement = false) {
  git(["switch", "--detach", revision], { inherit: true });
  installCurrentCheckout(forceServiceReplacement);
}

function serviceDrainCommand(command, { forceServiceReplacement = false, ignoreFailure = false } = {}) {
  const args = [path.join(SOURCE_ROOT, "src", "service-drain.mjs"), command];
  if (forceServiceReplacement) args.push("--force-service-replacement");
  const result = spawnSync(process.execPath, args, { cwd: SOURCE_ROOT, stdio: ignoreFailure ? "ignore" : "inherit" });
  if (!ignoreFailure && result.status !== 0) {
    throw new Error("Router replacement was deferred before the managed checkout changed.");
  }
}

function withPreparedServiceReplacement(operation, options = {}) {
  serviceDrainCommand("prepare", options);
  try {
    return operation();
  } finally {
    serviceDrainCommand("resume", { ignoreFailure: true });
  }
}

function checkForUpdate() {
  requireManagedCheckout();
  git(["fetch", "--quiet", "origin", "main"]);
  const current = git(["rev-parse", "HEAD"]);
  const available = git(["rev-parse", "origin/main"]);
  const relation = classifyUpdateRelation(current, available, revisionIsAncestor);
  if (relation === "diverged") {
    throw new Error(
      "The managed main branch has diverged from origin/main; refusing an automatic update.",
    );
  }
  return {
    current,
    available,
    relation,
    updateAvailable: relation === "remote-ahead",
  };
}

export function installationNeedsRefresh(manifest, revision) {
  return manifest?.current?.commit !== revision;
}

function updateCheckout({ force = false, forceServiceReplacement = false } = {}) {
  const status = checkForUpdate();
  if (!status.updateAvailable) {
    if (!installationNeedsRefresh(readInstallManifest(), status.current)) {
      return { ...status, updated: false, reinstalled: false };
    }
    withPreparedServiceReplacement(
      () => installCurrentCheckout(forceServiceReplacement),
      { forceServiceReplacement },
    );
    return { ...status, updated: false, reinstalled: true };
  }
  requireReplaceableCheckout(force);
  let branch = git(["branch", "--show-current"]);
  if (!branch) {
    git(["switch", "main"], { inherit: true });
    branch = "main";
  }
  if (branch !== "main") {
    throw new Error("Updates require the managed checkout to be on its main branch.");
  }
  withPreparedServiceReplacement(() => {
    git(["update-ref", "refs/codex-router/rollback", status.current]);
    git(["merge", "--ff-only", status.available], { inherit: true });
    try {
      installCurrentCheckout(forceServiceReplacement);
    } catch (error) {
      try {
        restoreRevision(status.current, forceServiceReplacement);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Update failed and automatic rollback also failed. The previous commit is ${status.current}.`,
        );
      }
      throw new Error(
        `Update failed; Codex Router was restored to ${status.current.slice(0, 12)}.`,
        { cause: error },
      );
    }
  }, { forceServiceReplacement });
  return { ...status, updated: true, reinstalled: true };
}

function rollbackCheckout({ force = false, forceServiceReplacement = false } = {}) {
  requireManagedCheckout();
  // A rollback checks out a different revision, so it overwrites tracked edits
  // exactly the way an update does.
  requireReplaceableCheckout(force);
  const current = git(["rev-parse", "HEAD"]);
  let target;
  try {
    target = git(["rev-parse", "refs/codex-router/rollback"]);
  } catch {
    target = readInstallManifest()?.history?.find((entry) => entry.commit)?.commit;
  }
  if (!target || !revisionExists(target)) {
    throw new Error("No locally cached working revision is available to roll back to.");
  }
  if (target === current) throw new Error("The rollback revision is already installed.");
  withPreparedServiceReplacement(() => {
    git(["update-ref", "refs/codex-router/rollback", current]);
    try {
      restoreRevision(target, forceServiceReplacement);
    } catch (error) {
      try {
        restoreRevision(current, forceServiceReplacement);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Rollback failed and the current revision could not be restored (${current}).`,
        );
      }
      throw error;
    }
  }, { forceServiceReplacement });
  return { rolledBack: true, from: current, to: target };
}

const COMMANDS = {
  check: checkForUpdate,
  update: updateCheckout,
  rollback: rollbackCheckout,
};

// `check` must stay read-only so callers can ask whether an update is available
// without touching the installation.
function resolveCommand(args) {
  return COMMANDS[args.find((argument) => !argument.startsWith("--")) || "update"];
}

// A bare `update --force` has to keep working, so the flag is stripped before
// the subcommand is read rather than being taken for one.
export function parseArguments(args) {
  return {
    command: resolveCommand(args),
    force: args.includes("--force"),
    forceServiceReplacement: args.includes("--force-service-replacement"),
  };
}

async function main() {
  const { command, force, forceServiceReplacement } = parseArguments(process.argv.slice(2));
  if (!command) {
    console.error("Usage: update.mjs check|update|rollback [--force] [--force-service-replacement]");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(command({ force, forceServiceReplacement }), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
