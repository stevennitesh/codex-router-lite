import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { findCodexBinary, spawnableCommand } from "./codex-binary.mjs";
import { assertCallerSecret, isManagedCallerBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import { refreshCodexCallerCapabilityContents } from "./caller-key-client-refresh.mjs";
import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { catalogPathsEqual, readNativeCatalogSource } from "./native-catalog-source.mjs";
import {
  BACKUP_PATH,
  CALLER_SECRET_PATH,
  CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  loopback,
} from "./paths.mjs";
import { scanTomlDocument } from "./toml-structure.mjs";

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
const managedAgentMaxConcurrency = 6;
const managedSubagentCompletionHint =
  "When a child agent finishes (FINAL_ANSWER, task_complete, or an idle/errored wait snapshot), call interrupt_agent on that child so Codex can mark it done. Do not leave finished children in the working state.";

const markerPairs = [
  [startMarker, endMarker],
  [providerStartMarker, providerEndMarker, `[model_providers.${routerProviderId}]`],
  [multiAgentStartMarker, multiAgentEndMarker],
];

function tomlValue(value) {
  return JSON.stringify(value);
}

function managedMultiAgentV2FeatureLine() {
  return (
    `multi_agent_v2 = { enabled = true, max_concurrent_threads_per_session = ${managedAgentMaxConcurrency}, ` +
    `expose_spawn_agent_model_overrides = true, usage_hint_enabled = true, ` +
    `root_agent_usage_hint_text = ${tomlValue(managedSubagentCompletionHint)} }`
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

function assignmentValue(line) {
  const raw = line.slice(line.indexOf("=") + 1).trim().replace(/\s+#.*$/, "");
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw.replace(/^(?:["'])|(?:["'])$/g, "");
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
  const expression = new RegExp(`^\\s*${key}\\s*=`);
  const matches = lines.filter((line) => expression.test(line));
  if (matches.length > 1) throw new Error(`Refusing duplicate root ${key} assignments.`);
  return matches[0] ? assignmentValue(matches[0]) : undefined;
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
  const output = [];
  for (let position = 0; position < headers.length; position += 1) {
    const start = headers[position].index;
    const end = headers[position + 1]?.index ?? innerLines.length;
    if (innerLines[start].trim() !== managedHeader) output.push(...innerLines.slice(start, end));
  }
  return output;
}

function recoverUnterminatedRouterRootBlock(input) {
  const lines = String(input).split("\n");
  const starts = lines
    .map((line, index) => line.trim() === startMarker ? index : -1)
    .filter((index) => index >= 0);
  const ends = lines.filter((line) => line.trim() === endMarker);
  if (starts.length !== 1 || ends.length !== 0) return String(input);

  const start = starts[0];
  const firstTable = scanTomlDocument(input).headers[0]?.index;
  if (firstTable === undefined || start >= firstTable) return String(input);

  const managed = lines.slice(start + 1, firstTable).filter((line) => line.trim());
  const required = [
    `openai_base_url = ${tomlValue(configuredRouterBaseUrl())}`,
    `model_catalog_json = ${tomlValue(MERGED_CATALOG_PATH)}`,
  ];
  const optional = new Map([
    [
      "experimental_realtime_webrtc_call_base_url",
      `experimental_realtime_webrtc_call_base_url = ${tomlValue(
        nativeRealtimeCallBaseUrl(lines.slice(0, start)),
      )}`,
    ],
    [
      "experimental_realtime_ws_base_url",
      `experimental_realtime_ws_base_url = ${tomlValue(defaultRealtimeWebsocketBaseUrl)}`,
    ],
  ]);
  const expected = [...required];
  for (const key of optional.keys()) {
    if (managed.some((line) => line.trim().startsWith(`${key} =`))) expected.push(optional.get(key));
  }
  if (
    managed.length !== expected.length ||
    managed.some((line, index) => line.trim() !== expected[index])
  ) return String(input);

  lines.splice(firstTable, 0, endMarker);
  return lines.join("\n");
}

function removeMarkerPair(input, start, end, managedHeader) {
  const lines = String(input).split("\n");
  const output = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim() !== start) {
      output.push(lines[index++]);
      continue;
    }
    const endIndex = lines.findIndex((line, candidate) => candidate > index && line.trim() === end);
    if (endIndex === -1) {
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
  const recovered = recoverUnterminatedRouterRootBlock(input);
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
  const managedBefore = markerPairs.some(([start]) => contents.includes(start));
  const withoutBlocks = removeEmptyFeaturesTable(removeManagedBlocks(contents));
  const { rootLines, tableLines } = splitRoot(withoutBlocks);
  const filtered = rootLines.filter((line) => {
    if (/^\s*openai_base_url\s*=/.test(line)) {
      const value = assignmentValue(line);
      return !(managedBefore && isManagedRouterBaseUrl(value));
    }
    if (/^\s*model_catalog_json\s*=/.test(line)) {
      return assignmentValue(line) !== MERGED_CATALOG_PATH;
    }
    return true;
  });
  return { rootLines: filtered, tableLines };
}

function hasMultiAgentConfig(contents) {
  const lines = String(contents).split("\n");
  return lines.some((line) =>
    /^\s*(?:features\.)?multi_agent_v2\s*=/.test(line) ||
    /^\s*\[features\.multi_agent_v2\]\s*(?:#.*)?$/.test(line) ||
    /^\s*\[agents\.[^\]]+\]\s*(?:#.*)?$/.test(line),
  );
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
      { encoding: "utf8", mode: 0o600 },
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

function withManagedMultiAgentV2(contents) {
  if (hasMultiAgentConfig(contents) || !installedCodexSupportsMultiAgentV2()) return contents;
  const lines = String(contents).split("\n");
  const { headers } = scanTomlDocument(contents);
  const features = headers.find((header) => header.path.length === 1 && header.path[0] === "features");
  const managed = [multiAgentStartMarker, managedMultiAgentV2FeatureLine(), multiAgentEndMarker];
  if (!features) {
    const firstTable = headers[0]?.index ?? lines.length;
    lines.splice(firstTable, 0, "", "[features]", ...managed);
  } else {
    const nextHeader = headers.find((header) => header.index > features.index);
    lines.splice(nextHeader?.index ?? lines.length, 0, ...managed, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function enabledContents(contents) {
  const routerBaseUrl = configuredRouterBaseUrl();
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
  rootLines = rootLines.filter((line) => !/^\s*model_catalog_json\s*=/.test(line));
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
  return withManagedMultiAgentV2(`${body.join("\n").trimEnd()}\n`);
}

function disabledContents(contents) {
  const cleaned = cleanedConfig(contents);
  const source = readNativeCatalogSource();
  const existingCatalog = rootValue(cleaned.rootLines, "model_catalog_json");
  if (existingCatalog && source && !catalogPathsEqual(existingCatalog, source.path)) {
    throw new Error(`Refusing to replace user-owned model_catalog_json: ${existingCatalog}`);
  }
  const rootLines = cleaned.rootLines.filter((line) => !/^\s*model_catalog_json\s*=/.test(line));
  if (source) rootLines.push(`model_catalog_json = ${tomlValue(source.path)}`);
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
      catalog === MERGED_CATALOG_PATH || markerPairs.some(([start]) => contents.includes(start)),
    openai_base_url: baseUrl ? redactCallerUrl(baseUrl) : null,
    model_catalog_json: catalog || null,
    config_protected: privateFileIsProtected(CONFIG_PATH),
  };
}

function atomicWrite(contents) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, CONFIG_PATH);
    protectPrivateFile(CONFIG_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

const validCommands = new Set([
  "enable",
  "disable",
  "status",
  "validate-enable",
  "caller-capability-refresh",
]);
if (!validCommands.has(command)) {
  console.error(
    "Usage: config-manager.mjs enable|disable|status|validate-enable|caller-capability-refresh",
  );
  process.exit(2);
}

const current = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
if (command === "status") {
  process.stdout.write(`${JSON.stringify(snapshot(current))}\n`);
  process.exit(0);
}
if (command === "validate-enable") {
  process.stdout.write(`${JSON.stringify(snapshot(enabledContents(current)))}\n`);
  process.exit(0);
}

let next;
if (command === "caller-capability-refresh") {
  if (snapshot(current).mode !== "router") {
    throw new Error("Codex Router is not the active managed route; refusing caller capability refresh.");
  }
  next = refreshCodexCallerCapabilityContents(current, configuredRouterBaseUrl(), {
    port: PORTS.router,
  });
} else {
  next = command === "enable" ? enabledContents(current) : disabledContents(current);
}

if (existsSync(CONFIG_PATH) && !existsSync(BACKUP_PATH)) copyFileSync(CONFIG_PATH, BACKUP_PATH);
if (existsSync(BACKUP_PATH)) protectPrivateFile(BACKUP_PATH);
atomicWrite(next);
process.stdout.write(`${JSON.stringify(snapshot(next))}\n`);
