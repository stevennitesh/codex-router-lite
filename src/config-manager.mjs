import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { findCodexBinary } from "./codex-binary.mjs";
import { assertCallerSecret, isManagedCallerBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import { refreshCodexCallerCapabilityContents } from "./caller-key-client-refresh.mjs";
import { createPrivateFile, privateFileIsProtected, protectPrivateFile, writePrivateFile } from "./file-security.mjs";
import { catalogPathsEqual, readNativeCatalogSource } from "./native-catalog-source.mjs";
import { readSubagentProtocol } from "./multi-agent-state.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import {
  BACKUP_PATH,
  CALLER_SECRET_PATH,
  CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";

const command = process.argv[2] || "status";
const routerProviderId = "codex-router";
const defaultChatgptBaseUrl = "https://chatgpt.com/backend-api";
const defaultRealtimeWebsocketBaseUrl = "https://api.openai.com/v1";
const startMarker = "# BEGIN codex-router-managed";
const endMarker = "# END codex-router-managed";
const providerStartMarker = "# BEGIN codex-router-provider-managed";
const providerEndMarker = "# END codex-router-provider-managed";
const multiAgentStartMarker = "# BEGIN codex-router-multi-agent-v2-managed";
const multiAgentEndMarker = "# END codex-router-multi-agent-v2-managed";
const multiAgentV1StartMarker = "# BEGIN codex-router-multi-agent-v1-managed";
const multiAgentV1EndMarker = "# END codex-router-multi-agent-v1-managed";
const managedAgentMaxConcurrency = 6;
const managedRootAgentUsageHint = `## Delegated-agent waiting
While a delegated agent has exclusive custody and an event-driven agent wait is available:
- Treat the pending wait as delegation progress rather than active local work. A general 60-second commentary cadence or limit on blocking waits does not apply to this event-driven wait.
- Use the longest practical event-driven interval allowed by the active workflow and runtime. Agent events and new user input can wake the wait early.
- Do not send commentary solely because time elapsed or a wait returned without a meaningful state change. Wait again without commentary. Report only a consequential question, blocker, error, custody transfer, completed candidate, meaningful state change, or user-requested status.
This exception ends when custody returns or useful local work resumes.

When a child agent finishes (FINAL_ANSWER, task_complete, or an idle/errored wait snapshot), call interrupt_agent on that child so Codex can mark it done. Do not leave finished children in the working state.`;

const managedDelegationUsageHint = `## Delegation routing
Delegate only when authorized by the user, applicable AGENTS.md, or an invoked skill. Follow that workflow's delegation policy; delegated work may intentionally be on the critical path to reduce parent context or cost.
- Do not duplicate work while a delegated agent has exclusive custody.
- Use the model, reasoning effort, and context fork required by the active workflow and supported by the available tools.
- If the active workflow calls for a fresh child context, use fork_turns="none" and supply the context needed for the task.`;

const markerPairs = [
  [startMarker, endMarker],
  [providerStartMarker, providerEndMarker, `[model_providers.${routerProviderId}]`],
  [multiAgentStartMarker, multiAgentEndMarker],
  [multiAgentV1StartMarker, multiAgentV1EndMarker],
];

function tomlValue(value) {
  return JSON.stringify(value);
}

function managedMultiAgentV2FeatureLine(rootHint = `${managedRootAgentUsageHint}\n\n${managedDelegationUsageHint}`) {
  return (
    `multi_agent_v2 = { enabled = true, max_concurrent_threads_per_session = ${managedAgentMaxConcurrency}, ` +
    `expose_spawn_agent_model_overrides = true, usage_hint_enabled = true, ` +
    `root_agent_usage_hint_text = ${tomlValue(rootHint)} }`
  );
}

function configuredRouterBaseUrl() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run .\\install.ps1 -Target codex.");
  }
  assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
  return loopback(PORTS.router, "/v1");
}

function isManagedRouterBaseUrl(value) {
  return value === loopback(PORTS.router, "/v1") || isManagedCallerBaseUrl(value, PORTS.router);
}

function rootAssignments(lines) {
  return scanTomlDocument(lines.join("\n")).assignments.filter(
    (assignment) => assignment.tablePath.length === 0 && assignment.key.length === 1,
  );
}

function filterRootAssignments(lines, keep) {
  const remove = new Set(rootAssignments(lines).filter((assignment) => !keep(assignment)).map(({ index }) => index));
  return lines.filter((_, index) => !remove.has(index));
}

function markerIndexes(input, marker) {
  return scanTomlDocument(input).comments.filter(({ text }) => text === marker).map(({ index }) => index);
}

function hasManagedMarkers(input) {
  const starts = new Set(markerPairs.map(([start]) => start));
  return scanTomlDocument(input).comments.some(({ text }) => starts.has(text));
}

function splitRoot(input) {
  const lines = String(input).split("\n");
  const firstTable = scanTomlDocument(input).headers[0]?.index ?? lines.length;
  return { rootLines: lines.slice(0, firstTable), tableLines: lines.slice(firstTable) };
}

function trimBlankEdges(lines) {
  const copy = [...lines];
  while (copy.length && !copy[0].trim()) copy.shift();
  while (copy.length && !copy.at(-1).trim()) copy.pop();
  return copy;
}

function rootValue(lines, key) {
  return tomlStringValue(scanTomlDocument(lines.join("\n")), [], key);
}

function rootHasValue(lines, key) {
  return rootValue(lines, key) !== undefined;
}

function nativeRealtimeCallBaseUrl(lines) {
  const base = (rootValue(lines, "chatgpt_base_url") || defaultChatgptBaseUrl).replace(/\/+$/, "");
  return base.endsWith("/codex") ? base : `${base}/codex`;
}

function foreignTableSegments(innerLines, managedHeader) {
  const { headers } = scanTomlDocument(innerLines.join("\n"));
  const managedPath = scanTomlDocument(managedHeader).headers[0].path;
  const output = [];
  for (let position = 0; position < headers.length; position += 1) {
    const start = headers[position].index;
    const end = headers[position + 1]?.index ?? innerLines.length;
    if (headers[position].path.length !== managedPath.length ||
        headers[position].path.some((part, index) => part !== managedPath[index])) {
      output.push(...innerLines.slice(start, end));
    }
  }
  return output;
}

function recoverUnterminatedRouterRootBlock(input) {
  const lines = String(input).split("\n");
  const starts = markerIndexes(input, startMarker);
  const ends = markerIndexes(input, endMarker);
  if (starts.length !== 1 || ends.length !== 0) return String(input);

  const start = starts[0];
  const required = [
    `openai_base_url = ${tomlValue(configuredRouterBaseUrl())}`,
    `model_catalog_json = ${tomlValue(MERGED_CATALOG_PATH)}`,
  ];
  const optional = [
      `experimental_realtime_webrtc_call_base_url = ${tomlValue(
        nativeRealtimeCallBaseUrl(lines.slice(0, start)),
      )}`,
      `experimental_realtime_ws_base_url = ${tomlValue(defaultRealtimeWebsocketBaseUrl)}`,
  ];
  let cursor = start + 1;
  for (const expected of required) {
    if (lines[cursor]?.trim() !== expected) return String(input);
    cursor += 1;
  }
  // These fields are emitted in a fixed order only when the user has no value
  // of their own. Consume exact matches as Router-owned. The first different
  // line belongs to the user and stays outside the repaired block.
  for (const expected of optional) {
    if (lines[cursor]?.trim() === expected) cursor += 1;
  }

  lines.splice(cursor, 0, endMarker);
  return lines.join("\n");
}

function recoverUnterminatedMultiAgentBlock(input) {
  const lines = String(input).split("\n");
  const starts = markerIndexes(input, multiAgentStartMarker);
  const ends = markerIndexes(input, multiAgentEndMarker);
  if (starts.length !== 1 || ends.length !== 0) return String(input);
  const start = starts[0];
  // Only an exact single-line feature emitted by this owner establishes the
  // missing boundary. A modified feature or following user content is never
  // inferred to be Router-owned.
  const ownedFeatures = [
    managedMultiAgentV2FeatureLine(),
    managedMultiAgentV2FeatureLine(managedRootAgentUsageHint), // Installed before delegation routing.
  ];
  if (!ownedFeatures.includes(lines[start + 1]?.trim())) return String(input);
  lines.splice(start + 2, 0, multiAgentEndMarker);
  return lines.join("\n");
}

function recoverUnterminatedV1MultiAgentBlock(input) {
  const lines = String(input).split("\n");
  const starts = markerIndexes(input, multiAgentV1StartMarker);
  const ends = markerIndexes(input, multiAgentV1EndMarker);
  if (starts.length !== 1 || ends.length !== 0) return String(input);
  const start = starts[0];
  if (lines[start + 1]?.trim() !== "multi_agent = true" ||
      lines[start + 2]?.trim() !== "multi_agent_v2 = false") return String(input);
  lines.splice(start + 3, 0, multiAgentV1EndMarker);
  return lines.join("\n");
}

function removeMarkerPair(input, start, end, managedHeader) {
  const lines = String(input).split("\n");
  const starts = new Set(markerIndexes(input, start));
  const ends = markerIndexes(input, end);
  const output = [];
  for (let index = 0; index < lines.length;) {
    if (!starts.has(index)) {
      output.push(lines[index++]);
      continue;
    }
    const endIndex = ends.find((candidate) => candidate > index);
    if (endIndex === undefined) {
      throw new Error(`Refusing to edit an unterminated managed block: ${start}.`);
    }
    if (managedHeader) {
      output.push(...foreignTableSegments(lines.slice(index + 1, endIndex), managedHeader));
    }
    index = endIndex + 1;
  }
  return output.join("\n");
}

function removeManagedBlocks(input) {
  const recovered = recoverUnterminatedV1MultiAgentBlock(recoverUnterminatedMultiAgentBlock(recoverUnterminatedRouterRootBlock(input)));
  return markerPairs.reduce(
    (contents, [start, end, managedHeader]) =>
      removeMarkerPair(contents, start, end, managedHeader),
    recovered,
  );
}

function removeEmptyFeaturesTable(input) {
  const lines = String(input).split("\n");
  const { headers } = scanTomlDocument(input);
  const remove = new Set();
  for (let position = 0; position < headers.length; position += 1) {
    const header = headers[position];
    if (header.path.length !== 1 || header.path[0] !== "features") continue;
    const end = headers[position + 1]?.index ?? lines.length;
    const hasValue = lines
      .slice(header.index + 1, end)
      .some((line) => line.trim() && !line.trim().startsWith("#"));
    if (!hasValue) for (let index = header.index; index < end; index += 1) remove.add(index);
  }
  return lines.filter((_, index) => !remove.has(index)).join("\n");
}

function cleanedConfig(contents) {
  const managedBefore = hasManagedMarkers(contents);
  const withoutBlocks = removeEmptyFeaturesTable(removeManagedBlocks(contents));
  const { rootLines, tableLines } = splitRoot(withoutBlocks);
  // Validate duplicate/invalid scalar assignments before any removal can hide them.
  const baseUrl = rootValue(rootLines, "openai_base_url");
  const catalog = rootValue(rootLines, "model_catalog_json");
  const filtered = filterRootAssignments(rootLines, ({ key: [key] }) => {
    if (key === "openai_base_url") {
      return !(managedBefore && isManagedRouterBaseUrl(baseUrl));
    }
    if (key === "model_catalog_json") {
      return !catalogPathsEqual(catalog, MERGED_CATALOG_PATH);
    }
    return true;
  });
  return { rootLines: filtered, tableLines };
}

function hasMultiAgentConfig(contents, { includeAgentTables = true } = {}) {
  const document = scanTomlDocument(contents);
  const names = new Set(["multi_agent", "multi_agent_v2"]);
  const isFeature = (parts) => parts[0] === "features" && names.has(parts[1]);
  return document.assignments.some(({ tablePath, key }) =>
    (key.length === 1 && names.has(key[0])) || isFeature([...tablePath, ...key]),
  ) || document.headers.some(({ path: parts }) => isFeature(parts) || (includeAgentTables && parts[0] === "agents" && parts.length > 1));
}

let multiAgentV2Supported;
function installedCodexSupportsMultiAgentV2() {
  if (multiAgentV2Supported !== undefined) return multiAgentV2Supported;
  const binary = findCodexBinary();
  if (!binary) return false;
  const probeHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-v2-probe-"));
  try {
    writeFileSync(
      path.join(probeHome, "config.toml"),
      `[features]\n${managedMultiAgentV2FeatureLine()}\n`,
      { encoding: "utf8" },
    );
    const probe = spawnableCommand(binary, ["login", "status"]);
    const result = spawnSync(probe.command, probe.args, {
      ...probe.options,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: probeHome },
    });
    multiAgentV2Supported = !result.error && !/Error loading configuration/i.test(
      `${result.stdout || ""}\n${result.stderr || ""}`,
    );
  } catch {
    multiAgentV2Supported = false;
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
  return multiAgentV2Supported;
}

function withManagedMultiAgent(contents, { protocol = readSubagentProtocol(), explicit = false } = {}) {
  if (hasMultiAgentConfig(contents, { includeAgentTables: !explicit })) {
    if (explicit) throw new Error("Refusing to replace user-owned multi-agent feature settings. Remove or reconcile those settings before selecting a Router-managed protocol.");
    return contents;
  }
  if (protocol === "v2" && !installedCodexSupportsMultiAgentV2()) {
    if (explicit) throw new Error("The installed Codex binary does not support the Router-managed V2 subagent feature.");
    return contents;
  }
  const lines = String(contents).split("\n");
  const { headers } = scanTomlDocument(contents);
  const features = headers.find((header) => header.path.length === 1 && header.path[0] === "features");
  const managed = protocol === "v1"
    ? [multiAgentV1StartMarker, "multi_agent = true", "multi_agent_v2 = false", multiAgentV1EndMarker]
    : [multiAgentStartMarker, managedMultiAgentV2FeatureLine(), multiAgentEndMarker];
  if (!features) {
    const firstTable = headers[0]?.index ?? lines.length;
    lines.splice(firstTable, 0, "", "[features]", ...managed);
  } else {
    const nextHeader = headers.find((header) => header.index > features.index);
    lines.splice(nextHeader?.index ?? lines.length, 0, ...managed, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function protocolContents(contents, protocol) {
  if (!["v1", "v2"].includes(protocol)) throw new Error("Subagent protocol must be v1 or v2.");
  const recovered = recoverUnterminatedV1MultiAgentBlock(recoverUnterminatedMultiAgentBlock(contents));
  const cleaned = [
    [multiAgentStartMarker, multiAgentEndMarker],
    [multiAgentV1StartMarker, multiAgentV1EndMarker],
  ].reduce((body, [start, end]) => removeMarkerPair(body, start, end), recovered);
  return withManagedMultiAgent(cleaned, { protocol, explicit: true });
}

function enabledContents(contents) {
  const routerBaseUrl = configuredRouterBaseUrl();
  const ownedMultiAgent = markerIndexes(contents, multiAgentStartMarker).length > 0 ||
    markerIndexes(contents, multiAgentV1StartMarker).length > 0;
  const cleaned = cleanedConfig(contents);
  let rootLines = trimBlankEdges(cleaned.rootLines);
  const existingBase = rootValue(rootLines, "openai_base_url");
  const existingCatalog = rootValue(rootLines, "model_catalog_json");
  const nativeSource = readNativeCatalogSource();
  if (existingBase && existingBase !== routerBaseUrl) {
    throw new Error(`Refusing to replace user-owned openai_base_url: ${redactCallerUrl(existingBase)}`);
  }
  if (
    existingCatalog &&
    existingCatalog !== MERGED_CATALOG_PATH &&
    !(nativeSource && catalogPathsEqual(existingCatalog, nativeSource.path))
  ) {
    throw new Error(`Refusing to replace user-owned model_catalog_json: ${existingCatalog}`);
  }
  rootLines = filterRootAssignments(rootLines, ({ key: [key] }) =>
    key !== "model_catalog_json" && key !== "openai_base_url",
  );
  if (scanTomlDocument(cleaned.tableLines.join("\n")).headers.some(({ path: parts }) =>
    parts.length === 2 && parts[0] === "model_providers" && parts[1] === routerProviderId)) {
    throw new Error(`Refusing to replace an unmarked model_providers.${routerProviderId} table.`);
  }
  const managedRealtime = [];
  if (!rootHasValue(rootLines, "experimental_realtime_webrtc_call_base_url")) {
    managedRealtime.push(
      `experimental_realtime_webrtc_call_base_url = ${tomlValue(nativeRealtimeCallBaseUrl(rootLines))}`,
    );
  }
  if (!rootHasValue(rootLines, "experimental_realtime_ws_base_url")) {
    managedRealtime.push(
      `experimental_realtime_ws_base_url = ${tomlValue(defaultRealtimeWebsocketBaseUrl)}`,
    );
  }
  rootLines.push(
    "",
    startMarker,
    `openai_base_url = ${tomlValue(routerBaseUrl)}`,
    `model_catalog_json = ${tomlValue(MERGED_CATALOG_PATH)}`,
    ...managedRealtime,
    endMarker,
  );
  const tables = trimBlankEdges(cleaned.tableLines);
  const body = [...trimBlankEdges(rootLines), "", ...tables, ...(tables.length ? [""] : [])];
  body.push(
    providerStartMarker,
    `[model_providers.${routerProviderId}]`,
    'name = "Codex Router (external models)"',
    `base_url = ${tomlValue(routerBaseUrl)}`,
    'wire_api = "responses"',
    "supports_standalone_web_search = true",
    "requires_openai_auth = true",
    providerEndMarker,
  );
  return withManagedMultiAgent(`${body.join("\n").trimEnd()}\n`, { explicit: ownedMultiAgent });
}

function disabledContents(contents) {
  const cleaned = cleanedConfig(contents);
  const source = readNativeCatalogSource();
  const existingCatalog = rootValue(cleaned.rootLines, "model_catalog_json");
  if (existingCatalog && source && !catalogPathsEqual(existingCatalog, source.path)) {
    throw new Error(`Refusing to replace user-owned model_catalog_json: ${existingCatalog}`);
  }
  const rootLines = [...cleaned.rootLines];
  if (source && existingCatalog === undefined) rootLines.push(`model_catalog_json = ${tomlValue(source.path)}`);
  return `${[
    ...trimBlankEdges(rootLines),
    "",
    ...trimBlankEdges(cleaned.tableLines),
  ].join("\n").trimEnd()}\n`;
}

function snapshot(contents) {
  const { rootLines } = splitRoot(contents);
  const baseUrl = rootValue(rootLines, "openai_base_url");
  const catalog = rootValue(rootLines, "model_catalog_json");
  return {
    mode: isManagedRouterBaseUrl(baseUrl) && catalog === MERGED_CATALOG_PATH ? "router" : "native",
    model: rootValue(rootLines, "model") || null,
    model_provider: rootValue(rootLines, "model_provider") || "openai",
    managed_router_artifacts_present:
      catalog === MERGED_CATALOG_PATH || hasManagedMarkers(contents),
    openai_base_url: baseUrl ? redactCallerUrl(baseUrl) : null,
    model_catalog_json: catalog || null,
    config_protected: privateFileIsProtected(CONFIG_PATH),
    subagent_protocol: readSubagentProtocol(),
    subagent_protocol_change_requires_restart: true,
    subagent_protocol_change_requires_new_conversation: true,
  };
}

function atomicWrite(contents) {
  writePrivateFile(CONFIG_PATH, contents);
}

const validCommands = new Set([
  "enable",
  "disable",
  "status",
  "validate-enable",
  "caller-capability-refresh",
  "subagent-protocol",
]);
if (!validCommands.has(command)) {
  console.error(
    "Usage: config-manager.mjs enable|disable|status|validate-enable|caller-capability-refresh|subagent-protocol <v1|v2>",
  );
  process.exit(2);
}

const current = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
if (command === "status") {
  process.stdout.write(`${JSON.stringify(snapshot(current))}\n`);
  process.exit(0);
}
if (command === "validate-enable") {
  const next = enabledContents(current);
  // Maintenance records the actual owner's exact transform without exposing
  // private configuration or authorizing arbitrary edits to unmanaged fields.
  const result = process.argv[3] === "--publication-plan"
    ? { beforeSha256: createHash("sha256").update(current).digest("hex"), afterSha256: createHash("sha256").update(next).digest("hex") }
    : snapshot(next);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

let next;
if (command === "subagent-protocol") {
  next = protocolContents(current, process.argv[3]);
} else if (command === "caller-capability-refresh") {
  if (snapshot(current).mode !== "router") {
    throw new Error("Codex Router is not the active managed route; refusing caller capability refresh.");
  }
  next = refreshCodexCallerCapabilityContents(current, configuredRouterBaseUrl(), {
    port: PORTS.router,
  });
} else {
  next = command === "enable" ? enabledContents(current) : disabledContents(current);
}

if (command !== "subagent-protocol") {
  if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) {
    createPrivateFile(BACKUP_PATH, readFileSync(CONFIG_PATH));
  } else if (existsSync(BACKUP_PATH)) {
    protectPrivateFile(BACKUP_PATH);
  }
}
atomicWrite(next);
process.stdout.write(`${JSON.stringify(snapshot(next))}\n`);
