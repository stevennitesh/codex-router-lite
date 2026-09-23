import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

import { writePrivateFile } from "./file-security.mjs";
import { CODEX_AGENTS_DIR } from "./paths.mjs";

function safeIdentifier(value, separator) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

// Only files matching this belong to the sync. Everything else in the agents
// directory is the user's own and is never read or removed here.
const MANAGED_AGENT_FILE = /^router-model-[a-z0-9-]+\.toml$/;

const RETIRED_MANAGED_AGENTS = new Map([
  [
    "ox_worker.toml",
    [
      'name = "ox_worker"',
      'description = "General-purpose Ox Alpha worker for bounded codebase reading, review, implementation, and verification."',
      'model_provider = "codex-router"',
      'model = "openrouter/ox-alpha"',
      'model_reasoning_effort = "high"',
      'model_context_window = 1048576',
      'model_reasoning_summary = "none"',
      'sandbox_mode = "workspace-write"',
      'developer_instructions = """',
      "Complete only the bounded assignment from the parent and do not delegate it further.",
      "Treat read-only work as read-only. For implementation work, preserve unrelated changes and do not commit, push, publish, or modify external systems unless the assignment explicitly authorizes it.",
      "Return a concise handoff with the result, verification evidence, changed files, and any material uncertainty or blocker.",
      '"""',
      "",
    ].join("\n"),
  ],
]);

function normalizedAgentContents(contents) {
  return String(contents).replace(/\r\n/g, "\n");
}

function managedAgentFiles(agentsDir) {
  try {
    return readdirSync(agentsDir).filter((entry) => {
      if (MANAGED_AGENT_FILE.test(entry)) return true;
      const retired = RETIRED_MANAGED_AGENTS.get(entry);
      if (!retired) return false;
      try {
        return normalizedAgentContents(readFileSync(path.join(agentsDir, entry), "utf8")) === retired;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function writeManagedAgent(target, contents) {
  writePrivateFile(target, contents);
}

export function routedAgentDefinition(model) {
  const slug = String(model?.slug || "").trim();
  if (!slug || !slug.includes("/")) {
    throw new Error(`Cannot create a routed agent for invalid model slug: ${slug || "<empty>"}`);
  }
  const fileStem = `router-model-${safeIdentifier(slug, "-")}`;
  const agentName = `router_${safeIdentifier(slug, "_")}`;
  const displayName = String(model.displayName || model.display_name || slug).trim();
  const defaultEffort = String(model.defaultEffort || "").trim();
  const supportedEfforts = new Set(
    (Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [])
      .map((level) => String(level?.effort || "").trim())
      .filter(Boolean),
  );
  if (!defaultEffort || !supportedEfforts.has(defaultEffort)) {
    throw new Error(`Cannot create a routed agent without a supported default effort: ${slug}`);
  }
  const contents = [
    "# Managed by Codex Router. Refresh the model catalog to update this file.",
    `name = ${tomlString(agentName)}`,
    `description = ${tomlString(`${displayName} agent routed through an authenticated Codex Router provider.`)}`,
    'model_provider = "codex-router"',
    `model = ${tomlString(slug)}`,
    `model_reasoning_effort = ${tomlString(defaultEffort)}`,
    "",
    'developer_instructions = """',
    "Complete the bounded task assigned by the parent agent.",
    "Respect repository instructions, keep changes surgical, and run relevant verification.",
    "For every task, locate relevant files, symbols or sections before reading bounded excerpts, normally 100-200 lines or a few thousand output tokens. Read a small file in full when useful; expand larger reads only for a concrete information gap. Avoid overlapping broad reads; narrow truncated searches instead of merely requesting larger output. Reuse completed checks while their inputs remain unchanged.",
    "Keep track of the objective, completed work, verified evidence, rejected approaches and remaining questions. After compaction, continue from that state and re-read only missing evidence or changed state. Finish when the assignment's completion criteria are met. Treat stated maximums as limits, not targets; do not invent work or results to fill them. A final answer must contain the result or blocker, not a progress update.",
    "Support factual claims with direct evidence and cite exact files and lines when relevant. Before claiming that something is absent, search the relevant names and paths. Recheck evidence when its source changes or its accuracy is uncertain, and drop unsupported claims.",
    "Use only tool names, agent types, and model overrides offered by the current tool schema. Never invent or reuse a stale name; omit an optional override when no offered value fits.",
    "Do not stop after merely announcing a next action. Execute it when it is within scope, or report the exact blocker or decision needed.",
    "Return a concise final response with work completed, checks run, and remaining risks. Use collaboration messages for intermediate updates or when explicitly requested; they do not complete your turn. Put completed results in the final response without an unnecessary status-message call first.",
    '"""',
    "",
  ].join("\n");
  return { agentName, fileName: `${fileStem}.toml`, contents };
}

// Writes one definition per model, and removes the definitions of models that
// are no longer passed in. Codex offers every file in the agents directory by
// name, so a definition left behind keeps a model spawnable through
// `agent_type` after the settings stopped allowing it.
export function syncRoutedCodexAgents(models, agentsDir = CODEX_AGENTS_DIR) {
  mkdirSync(agentsDir, { recursive: true });
  const previous = new Map(
    managedAgentFiles(agentsDir).map((entry) => [
      entry,
      readFileSync(path.join(agentsDir, entry), "utf8"),
    ]),
  );
  const written = [];
  const changed = [];
  const keep = new Set();
  try {
    for (const model of models) {
      const definition = routedAgentDefinition(model);
      const target = path.join(agentsDir, definition.fileName);
      const current = previous.get(definition.fileName);
      if (current === undefined || normalizedAgentContents(current) !== definition.contents) {
        writeManagedAgent(target, definition.contents);
        changed.push(definition.fileName);
      }
      keep.add(definition.fileName);
      written.push({ model: model.slug, agent: definition.agentName, path: target });
    }
    const removed = [];
    for (const entry of managedAgentFiles(agentsDir)) {
      if (keep.has(entry)) continue;
      try {
        unlinkSync(path.join(agentsDir, entry));
        removed.push(entry);
      } catch {
        // A definition that cannot be removed is reported by the doctor check
        // rather than failing the catalog write.
      }
    }
    return { written, changed, removed };
  } catch (error) {
    const restoreErrors = [];
    for (const entry of managedAgentFiles(agentsDir)) {
      if (previous.has(entry)) continue;
      try {
        unlinkSync(path.join(agentsDir, entry));
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    for (const [entry, contents] of previous) {
      try {
        writeManagedAgent(path.join(agentsDir, entry), contents);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length) {
      throw new AggregateError(
        [error, ...restoreErrors],
        "Routed agent catalog update failed and its previous files could not be restored.",
      );
    }
    throw error;
  }
}
