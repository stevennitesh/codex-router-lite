import {
  isManagedCodexBaseUrl,
} from "./caller-auth.mjs";

const CODEX_PROVIDER_BEGIN = "# BEGIN codex-router-provider-managed";
const CODEX_PROVIDER_END = "# END codex-router-provider-managed";
const CODEX_SIGNED_BEGIN = "# BEGIN codex-router-signed-provider-managed";
const CODEX_SIGNED_END = "# END codex-router-signed-provider-managed";

function decodeScalar(raw) {
  const token = String(raw ?? "").trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try { return JSON.parse(token); } catch { return undefined; }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
  return token.split(/\s+#/, 1)[0].trim();
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAssignmentLine(line, key, value, separator = "=") {
  const escaped = escapedPattern(key);
  const operator = separator === ":" ? ":" : "=";
  const pattern = new RegExp(`^(\\s*${escaped}\\s*${operator}\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^#\\s]+)(\\s*(?:#.*)?)$`);
  const match = line.match(pattern);
  if (!match) throw new Error(`Managed ${key} assignment is not a supported scalar.`);
  return `${match[1]}${JSON.stringify(value)}${match[3]}`;
}

function assignmentValue(line, key, separator = "=") {
  const escaped = escapedPattern(key);
  const operator = separator === ":" ? ":" : "=";
  const match = line.match(new RegExp(`^\\s*${escaped}\\s*${operator}\\s*(.+?)\\s*$`));
  return match ? decodeScalar(match[1]) : undefined;
}

function managedCodexBase(value, port, legacyPort) {
  return isManagedCodexBaseUrl(value, port) ||
    (legacyPort !== undefined && isManagedCodexBaseUrl(value, legacyPort));
}

function replaceRootCallerBase(contents, nextBase, port, legacyPort) {
  const lines = contents.split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const matches = [];
  for (let index = 0; index < end; index += 1) {
    if (/^\s*openai_base_url\s*=/.test(lines[index])) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error("Codex caller capability refresh requires exactly one managed openai_base_url.");
  }
  const oldBase = assignmentValue(lines[matches[0]], "openai_base_url");
  if (!managedCodexBase(oldBase, port, legacyPort)) {
    throw new Error("Codex openai_base_url is not a managed router URL.");
  }
  lines[matches[0]] = replaceAssignmentLine(lines[matches[0]], "openai_base_url", nextBase);
  return lines.join("\n");
}

function replaceMarkedBase(contents, begin, end, nextBase, port, legacyPort) {
  const lines = contents.split("\n");
  const starts = lines.flatMap((line, index) => line.trim() === begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line.trim() === end ? [index] : []);
  if (!starts.length && !ends.length) return contents;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error(`Managed caller capability block ${begin} is ambiguous.`);
  }
  const matches = [];
  for (let index = starts[0] + 1; index < ends[0]; index += 1) {
    if (/^\s*base_url\s*=/.test(lines[index])) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`Managed caller capability block ${begin} has no unique base_url.`);
  }
  const oldBase = assignmentValue(lines[matches[0]], "base_url");
  if (!managedCodexBase(oldBase, port, legacyPort)) {
    throw new Error(`Managed Codex block ${begin} has an unmanaged base_url.`);
  }
  lines[matches[0]] = replaceAssignmentLine(lines[matches[0]], "base_url", nextBase);
  return lines.join("\n");
}

export function refreshCodexCallerCapabilityContents(contents, nextBase, { port, legacyPort } = {}) {
  if (!isManagedCodexBaseUrl(nextBase, port)) {
    throw new Error("Refusing an invalid Codex router URL.");
  }
  let next = replaceRootCallerBase(String(contents ?? ""), nextBase, port, legacyPort);
  next = replaceMarkedBase(next, CODEX_PROVIDER_BEGIN, CODEX_PROVIDER_END, nextBase, port, legacyPort);
  next = replaceMarkedBase(next, CODEX_SIGNED_BEGIN, CODEX_SIGNED_END, nextBase, port, legacyPort);
  return next;
}

export function refreshCodexCallerCapabilityState(state, nextBase, { port, legacyPort } = {}) {
  if (!state || typeof state !== "object") return state;
  if (!("managedBaseUrl" in state)) return { ...state };
  if (!managedCodexBase(state.managedBaseUrl, port, legacyPort) || !isManagedCodexBaseUrl(nextBase, port)) {
    throw new Error("Codex managed provider state contains an invalid router URL.");
  }
  return { ...state, managedBaseUrl: nextBase };
}
