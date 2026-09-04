import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import {
  INSTALL_MANIFEST_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";
import { serviceProxyEnvironment } from "./proxy-environment.mjs";
import { packSkillNames } from "./skills-install.mjs";

function gitValue(args) {
  try {
    return execFileSync("git", ["-C", SOURCE_ROOT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function packageVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"),
    ).version;
  } catch {
    return null;
  }
}

export function readInstallManifest() {
  if (!existsSync(INSTALL_MANIFEST_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(INSTALL_MANIFEST_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function atomicWrite(value) {
  writePrivateJson(INSTALL_MANIFEST_PATH, value);
}

function recordInstall() {
  const previous = readInstallManifest();
  // Derive the skills field from the checkout because install.ps1 records the
  // manifest before installing skills. Filesystem state still describes the
  // previous installation at this point.
  const names = packSkillNames();
  const skills = { names, count: names.length };
  const current = {
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
    packageVersion: packageVersion(),
    installedAt: new Date().toISOString(),
    sourceRoot: SOURCE_ROOT,
    target: TARGET,
    platform: process.platform,
    packageManager: process.env.CODEX_ROUTER_PACKAGE_MANAGER || null,
    // Recorded so a later repair can put it back. A repair started from a
    // desktop app inherits no shell environment, and serviceProxyEnvironment()
    // reads this field precisely to avoid rewriting the service without the
    // proxy the operator configured.
    //
    // A proxy URL may embed `user:password@`, so this owner-only file has the
    // same sensitivity as the service definition.
    proxyEnvironment: serviceProxyEnvironment(),
    providers: providerSelectionStatus().providers,
    skills,
  };
  const previousEntry = previous?.current;
  const history = [
    ...(previousEntry && previousEntry.commit !== current.commit ? [previousEntry] : []),
    ...(previous?.history || []),
  ].slice(0, 10);
  const manifest = { version: 1, current, history };
  atomicWrite(manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  if (command === "record") {
    process.stdout.write(`${JSON.stringify(recordInstall(), null, 2)}\n`);
  } else if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(readInstallManifest() || { installed: false }, null, 2)}\n`,
    );
  } else {
    console.error("Usage: install-manifest.mjs record|status");
    process.exit(2);
  }
}
