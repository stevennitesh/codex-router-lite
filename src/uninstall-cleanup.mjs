import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncRoutedCodexAgents } from "./codex-agent-catalog.mjs";
import { writePrivateFile } from "./file-security.mjs";
import { BACKUP_PATH, CODEX_AGENTS_DIR, CODEX_HOME, CONFIG_PATH, SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { assertServiceWriteIsolated } from "./service-write-guard.mjs";
import { uninstallSkills } from "./skills-install.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";
import { rollbackWebStopAdapter } from "./web-stop-adapter-install.mjs";

function stat(target) {
  try { return lstatSync(target); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

function pathKey(target) {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pruneObsoleteRouterSettings(contents, {
  codexHome, sourceRoot, adapterRemoved, hookFileExists = target => Boolean(stat(target)),
}) {
  const doc = scanTomlDocument(contents);
  const userHooks = path.join(codexHome, "hooks.json");
  const checkoutHooks = path.join(sourceRoot, ".codex", "hooks.json");
  const obsoleteSkill = pathKey(path.join(codexHome, "skills", "codex-router-media", "SKILL.md"));
  const remove = new Set();
  for (const [position, header] of doc.headers.entries()) {
    const [section, table, key] = header.path;
    const end = doc.headers[position + 1]?.index ?? doc.lines.length;
    const lines = doc.lines.slice(header.index + 1, end);
    const fields = lines.filter(line => line.trim() && !line.trimStart().startsWith("#"));
    let owned = false;
    if (header.array && section === "skills" && table === "config" && header.path.length === 2) {
      const block = scanTomlDocument(doc.lines.slice(header.index, end).join("\n"));
      const skillPath = block.assignments.find(assignment => assignment.key.length === 1
        && assignment.key[0] === "path" && assignment.kind === "string")?.value;
      owned = Boolean(skillPath && path.isAbsolute(skillPath) && pathKey(skillPath) === obsoleteSkill
        && fields.length === 2 && fields.some(line => /^\s*enabled\s*=\s*false\s*(?:#.*)?$/u.test(line)));
    }
    if (!header.array && section === "hooks" && table === "state" && header.path.length === 3) {
      const match = /^(.*):([a-z_]+):\d+:\d+$/iu.exec(key);
      if (match && path.isAbsolute(match[1])) {
        const source = pathKey(match[1]);
        owned = (source === pathKey(checkoutHooks) && !hookFileExists(checkoutHooks))
          || (adapterRemoved && source === pathKey(userHooks)
            && match[2].toLowerCase() === "interrupt" && !hookFileExists(userHooks));
      }
    }
    if (owned) {
      remove.add(header.index);
      for (let index = header.index + 1; index < end; index += 1) {
        if (doc.lines[index].trim() && !doc.lines[index].trimStart().startsWith("#")) remove.add(index);
      }
    }
  }
  return doc.lines.filter((_, index) => !remove.has(index)).join("\n");
}

function removeOptionalWorker() {
  const target = path.join(CODEX_AGENTS_DIR, "switchyard_worker.toml");
  if (!stat(target)?.isFile()) return;
  const template = path.join(SOURCE_ROOT, "config", "switchyard", "switchyard_worker.toml");
  const read = file => readFileSync(file, "utf8").replace(/\r\n/gu, "\n");
  if (read(target) === read(template)) unlinkSync(target);
  else console.error("Preserved a modified switchyard_worker.toml. Review it manually if it still uses the router.");
}

function verifyUnlinkedTree(target) {
  const entry = lstatSync(target);
  if (entry.isSymbolicLink()) throw new Error("Refusing to purge Router state containing a link or junction.");
  if (entry.isDirectory()) for (const child of readdirSync(target)) verifyUnlinkedTree(path.join(target, child));
}

function contains(directory, target) {
  const relative = path.relative(pathKey(directory), pathKey(target));
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function purgeOwnedState(contents) {
  const expected = path.join(CODEX_HOME, "codex-router");
  if (pathKey(STATE_DIR) !== pathKey(expected)) {
    throw new Error("Automatic purge only supports the default Router state directory. Review the custom directory manually.");
  }
  if (stat(STATE_DIR)) {
    const directory = realpathSync(STATE_DIR);
    const catalog = tomlStringValue(scanTomlDocument(contents), [], "model_catalog_json");
    if (!stat(STATE_DIR).isDirectory()
      || pathKey(directory) !== pathKey(path.join(realpathSync(CODEX_HOME), "codex-router"))
      || contains(directory, realpathSync(SOURCE_ROOT))
      || (catalog && (contains(STATE_DIR, path.resolve(CODEX_HOME, catalog))
        || (stat(path.resolve(CODEX_HOME, catalog)) && contains(directory, realpathSync(path.resolve(CODEX_HOME, catalog))))))) {
      throw new Error("Refusing to purge Router state with an unexpected path, source checkout, or active catalog inside it.");
    }
    verifyUnlinkedTree(STATE_DIR);
    rmSync(STATE_DIR, { recursive: true });
  }
  if (stat(BACKUP_PATH)?.isFile()) unlinkSync(BACKUP_PATH);
}

function cleanup(args) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--purge-owned-state")) {
    throw new Error("Usage: uninstall-cleanup.mjs [--purge-owned-state]");
  }
  assertServiceWriteIsolated(CODEX_HOME, { redirected: process.env.CODEX_HOME
    && pathKey(CODEX_HOME) !== pathKey(path.join(process.env.USERPROFILE || process.env.HOME || CODEX_HOME, ".codex")),
  label: "Codex uninstall cleanup", override: "CODEX_HOME" });
  for (const name of ["service-process.json", "start-codex-router.cmd", "start-codex-router-hidden.vbs"]) {
    if (stat(path.join(STATE_DIR, name))) throw new Error("Remove the managed Router service before running uninstall cleanup.");
  }

  const adapter = rollbackWebStopAdapter();
  if (adapter.conflicts?.length) {
    throw new Error("Stop adapter cleanup requires review: " + adapter.conflicts.join(" "));
  }
  uninstallSkills(CODEX_HOME);
  const agents = stat(CODEX_AGENTS_DIR);
  if (agents && !agents.isDirectory()) throw new Error("Review the linked or non-directory Codex agents path manually.");
  syncRoutedCodexAgents([]);
  removeOptionalWorker();
  const before = stat(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  const after = pruneObsoleteRouterSettings(before, {
    codexHome: CODEX_HOME, sourceRoot: SOURCE_ROOT, adapterRemoved: adapter.state === "removed",
  });
  if (after !== before) {
    if (readFileSync(CONFIG_PATH, "utf8") !== before) throw new Error("Codex settings changed during uninstall. Retry cleanup.");
    writePrivateFile(CONFIG_PATH, after);
  }
  if (args.length) purgeOwnedState(after);
  console.log("Router integration removed. Fully quit and reopen Codex to reload its settings.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cleanup(process.argv.slice(2)); }
  catch (error) {
    console.error("Router uninstall cleanup failed: " + error.message);
    process.exitCode = 1;
  }
}
