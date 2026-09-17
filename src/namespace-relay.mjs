import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import { jsonNumberIsStableForRewrite } from "./json-number-rewrite.mjs";
import { HeaderlessSseDetector } from "./sse-prefix.mjs";
import { coerceFunctionCallArguments } from "./tool-arguments.mjs";
import { providerToolSchema } from "./tool-schema-root.mjs";

// The Codex client ships most of its toolset as `type: "namespace"` entries:
// the collaboration runtime, the app toolset (threads, automations,
// navigation), and every MCP server (node_repl, peekaboo, github, ...).
//
// LiteLLM's Responses -> Chat Completions bridge drops namespace tools, which
// is how the app sends all of those to the model. A routed chat-completions
// provider would therefore see none of them: no collaboration tools, no
// threads, and no `mcp__node_repl__js` -- the runtime the in-app browser and
// computer-use skills drive. This module is the one relay for all of it:
//
//   1. flattenNamespaceTools        -- namespace entries -> plain
//                                      `<namespace>__<tool>` functions the
//                                      provider accepts
//   2. flattenNamespacedHistory     -- stored calls renamed to the flattened
//                                      form so the model's transcript matches
//                                      its tool list
//   3. NamespaceToolCallTransform   -- function calls coming back restored to
//                                      the app's native `{name, namespace}`
//                                      shape so the client dispatches them
//
// The router only relays definitions and results; it never executes an app
// tool itself. Namespace names themselves may contain the delimiter
// (`mcp__codex_apps__github`), so restoration always resolves through the map
// built from the exact tools that were flattened -- never by splitting names.

const NAMESPACE_DELIMITER = "__";
const DEFAULT_FUNCTION_NAMESPACE = "functions";
const MCP_NAMESPACE_PREFIX = "mcp__";

// Metadata derived from the request's exact tool schema. Keeping it beside the
// Map in a WeakMap preserves the Map's public shape for existing callers while
// letting the response path validate model-generated overrides.
const SPAWN_AGENT_MODELS = new WeakMap();
const TOOL_SEARCH_RELAYS = new WeakMap();
const CUSTOM_TOOL_RELAYS = new WeakMap();
// Preserve the native identity while a namespaced freeform declaration is
// flattened. Its provider spelling is not the name Codex dispatches.
const CUSTOM_TOOL_IDENTITIES = new WeakMap();
const NAME_ALIASES = new WeakMap();
const PLAIN_TOOL_NAMES = new WeakMap();
// A provider-facing function reference can retain the same spelling as a
// bridged custom/tool-search relay while a later-discovered ordinary function
// with that native name receives an alias. Object identity is the only honest
// discriminator after both shapes have become `type: "function"`; keep it
// request-local and garbage-collectable rather than guessing from the name.
const SPECIAL_FUNCTION_REFERENCES = new WeakSet();

const TOOL_SEARCH_FUNCTION_NAME = "tool_search";
const CUSTOM_TOOL_INPUT_PROPERTY = "input";

function providerFunctionName(tool) {
  return tool?.name ?? tool?.function?.name;
}

function withProviderFunctionName(tool, name) {
  if (tool?.function?.name !== undefined) {
    return { ...tool, function: { ...tool.function, name } };
  }
  return { ...tool, name };
}

function nativeToolKey(namespace, name) {
  return JSON.stringify([namespace ?? null, name]);
}

function boundedNameCandidate(wireName, identity, maxNameLength, attempt) {
  const digest = createHash("sha256")
    .update(`${identity}\0${attempt}`)
    .digest("hex")
    .slice(0, 12);
  const suffix = `_${digest}`;
  if (!Number.isFinite(maxNameLength)) return `${wireName}${suffix}`;
  return `${wireName.slice(0, maxNameLength - suffix.length)}${suffix}`;
}

function assignProviderName(relay, identity, wireName, native, { forceAlias = false } = {}) {
  const existing = relay.nativeToProvider.get(identity);
  if (existing) return existing;

  let providerName = wireName;
  if (
    forceAlias ||
    wireName.length > relay.maxNameLength ||
    relay.providerOwners.has(wireName)
  ) {
    let attempt = 0;
    do {
      providerName = boundedNameCandidate(
        wireName,
        identity,
        relay.maxNameLength,
        attempt,
      );
      attempt += 1;
    } while (relay.providerOwners.has(providerName));
  }

  relay.nativeToProvider.set(identity, providerName);
  relay.providerOwners.set(providerName, identity);
  if (native && providerName !== wireName) relay.providerToNative.set(providerName, native);
  if (native) {
    if (native.namespace === undefined) relay.plainProviderNames.add(providerName);
    if (!relay.wireOwners.has(wireName)) relay.wireOwners.set(wireName, new Set());
    relay.wireOwners.get(wireName).add(identity);
  }
  return providerName;
}

function initialFunctionIdentities(tools) {
  const identities = new Map();
  if (!Array.isArray(tools)) return identities;
  for (const tool of tools) {
    if (tool?.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (child?.type !== "function" || typeof child.name !== "string" || !child.name) continue;
        const wireName = `${tool.name}${NAMESPACE_DELIMITER}${child.name}`;
        const native = { namespace: tool.name, name: child.name };
        identities.set(nativeToolKey(native.namespace, native.name), { wireName, native });
      }
      continue;
    }
    if (tool?.type !== "function") continue;
    const name = providerFunctionName(tool);
    if (typeof name !== "string" || !name) continue;
    const native = { name };
    identities.set(nativeToolKey(undefined, name), { wireName: name, native });
  }
  return identities;
}

function initializeNameAliases(namespaces, tools, maxNameLength, aliasCollisions = false) {
  const bounded = Number.isInteger(maxNameLength) && maxNameLength >= 16;
  if (!bounded && !aliasCollisions) return undefined;
  const relay = {
    maxNameLength: bounded ? maxNameLength : Infinity,
    nativeToProvider: new Map(),
    providerToNative: new Map(),
    providerOwners: new Map(),
    plainProviderNames: new Set(),
    wireOwners: new Map(),
  };
  NAME_ALIASES.set(namespaces, relay);

  const identities = initialFunctionIdentities(tools);
  const wireCounts = new Map();
  for (const { wireName } of identities.values()) {
    wireCounts.set(wireName, (wireCounts.get(wireName) || 0) + 1);
  }

  // Reserve every legal, unique name first. Long names and native collisions
  // are then assigned in stable identity order, so reordering an otherwise
  // identical tool list cannot change the aliases sent to the provider.
  const pending = [];
  for (const [identity, entry] of [...identities].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (entry.wireName.length <= relay.maxNameLength && wireCounts.get(entry.wireName) === 1) {
      assignProviderName(relay, identity, entry.wireName, entry.native);
    } else {
      pending.push([identity, entry]);
    }
  }
  for (const [identity, entry] of pending) {
    assignProviderName(relay, identity, entry.wireName, entry.native, { forceAlias: true });
  }
  return relay;
}

function providerNameForNative(namespaces, namespace, name) {
  const relay = NAME_ALIASES.get(namespaces);
  if (!relay) return namespace === undefined ? name : `${namespace}${NAMESPACE_DELIMITER}${name}`;
  const identity = nativeToolKey(namespace, name);
  const existing = relay.nativeToProvider.get(identity);
  if (existing) return existing;
  const wireName = namespace === undefined ? name : `${namespace}${NAMESPACE_DELIMITER}${name}`;
  return assignProviderName(relay, identity, wireName, {
    ...(namespace === undefined ? {} : { namespace }),
    name,
  });
}

function reserveSpecialProviderName(namespaces, identity, wireName) {
  const relay = NAME_ALIASES.get(namespaces);
  if (!relay) return wireName;
  return assignProviderName(relay, identity, wireName);
}

function providerNameForWire(namespaces, wireName) {
  const relay = NAME_ALIASES.get(namespaces);
  if (!relay) return undefined;
  const owners = relay.wireOwners.get(wireName);
  if (!owners || owners.size !== 1) return undefined;
  const [identity] = owners;
  return relay.nativeToProvider.get(identity);
}

function providerVisibleToolNames(tools) {
  const names = new Set();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      if (typeof tool.name === "string" && tool.name) names.add(tool.name);
      for (const fn of tool.tools) {
        if (fn?.name) names.add(`${tool.name}${NAMESPACE_DELIMITER}${fn.name}`);
      }
      continue;
    }
    const name = providerFunctionName(tool);
    if (typeof name === "string" && name) names.add(name);
  }
  return names;
}

function availableCustomToolName(nativeName, visibleNames) {
  if (!visibleNames.has(nativeName)) return nativeName;
  const stem = `codex_custom_${nativeName}`;
  if (!visibleNames.has(stem)) return stem;
  let suffix = 1;
  while (visibleNames.has(`${stem}_${suffix}`)) suffix += 1;
  return `${stem}_${suffix}`;
}

// A custom tool's `format` is the model's only specification of the freeform
// payload it must emit: Codex ships apply_patch's V4A dialect as a lark
// grammar and describes the format nowhere else. A function tool has no
// grammar slot, so dropping `format.definition` on the way through would hand
// the model a bare "raw input" string and leave any model that has not
// memorised V4A emitting patches Codex cannot parse. Carry the definition in
// the bridged description instead -- that is the one field every
// function-tool provider does put in front of the model.
function bridgedCustomToolDescription(tool) {
  const sections = [];
  if (typeof tool?.description === "string" && tool.description.trim()) {
    sections.push(tool.description.trim());
  }
  const format = tool?.format;
  const definition = typeof format?.definition === "string" ? format.definition.trim() : "";
  if (definition) {
    const syntax = typeof format?.syntax === "string" && format.syntax.trim()
      ? format.syntax.trim()
      : "grammar";
    sections.push(
      `The \`${CUSTOM_TOOL_INPUT_PROPERTY}\` string is freeform text, not JSON, and must parse ` +
        `against this ${syntax} grammar:\n\n${definition}`,
    );
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

// LiteLLM's Chat Completions bridge accepts ordinary JSON-schema functions,
// not OpenAI's freeform `type: "custom"` definition. Codex exposes apply_patch
// in that native form. Present the same raw-patch contract as one required string
// property, translate matching history and a forced native custom choice, and
// retain a request-local reverse map so the response path can restore the exact
// custom-tool shape Codex executes. An unrelated function or native namespace
// with the same name receives a collision-safe alias and is otherwise untouched.
export function bridgeCustomTools(
  tools,
  input,
  namespaces,
  toolChoice,
  names = ["apply_patch"],
  { maxNameLength, bridgeAll = false } = {},
) {
  if (!(namespaces instanceof Map)) {
    return { tools, input, toolChoice, bridged: false };
  }
  if (Number.isInteger(maxNameLength) && !NAME_ALIASES.has(namespaces)) {
    initializeNameAliases(namespaces, tools, maxNameLength);
  }
  const requested = new Set(names);
  const shouldBridge = (name) => bridgeAll || requested.has(name);
  const declaredIdentity = (item) => CUSTOM_TOOL_IDENTITIES.get(item) || {
    name: item.name,
    ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
  };
  const keyOf = (identity) => nativeToolKey(identity.namespace, identity.name);
  const declaredCustom = new Map();
  const plainNames = new Set(PLAIN_TOOL_NAMES.get(namespaces) || []);
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type !== "custom") continue;
    const native = declaredIdentity(tool);
    declaredCustom.set(keyOf(native), native);
    if (native.namespace === undefined) plainNames.add(native.name);
  }
  const identityOf = (item) => {
    const native = declaredIdentity(item);
    // Native Codex can omit its default `functions` namespace in produced
    // custom calls. Resolve that shorthand against the actual declaration,
    // otherwise replay teaches the provider a different tool name. An exact
    // plain declaration wins; never guess another namespace from a bare name.
    if (native.namespace === undefined && !plainNames.has(native.name)) {
      return declaredCustom.get(nativeToolKey("functions", native.name)) || native;
    }
    return native;
  };
  const nativeNames = new Map();
  const remember = (item) => {
    const native = identityOf(item);
    const { name } = native;
    if (
      typeof name === "string" &&
      name &&
      shouldBridge(name) &&
      !nativeNames.has(keyOf(native))
    ) {
      nativeNames.set(keyOf(native), native);
    }
  };
  if (Array.isArray(tools)) {
    for (const tool of tools) if (tool?.type === "custom") remember(tool);
  }
  if (Array.isArray(input)) {
    for (const item of input) if (item?.type === "custom_tool_call") remember(item);
  }
  if (toolChoice?.type === "custom") remember(toolChoice);
  if (toolChoice?.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    for (const choice of toolChoice.tools) {
      if (choice?.type === "custom") remember(choice);
    }
  }
  if (!nativeNames.size) return { tools, input, toolChoice, bridged: false };

  // Once native custom-tool history is rewritten as a function call, its
  // optional item id must obey the function-call id contract. Strict Responses
  // endpoints reject ctc_/ctco_ ids on function-shaped items. call_id still
  // pairs each call with its output, while an already-compatible fc id is safe.
  const withoutIncompatibleFunctionItemId = (item) => {
    if (typeof item?.id !== "string" || item.id.startsWith("fc")) return item;
    const { id: _id, ...rest } = item;
    return rest;
  };

  const ordinaryTools = Array.isArray(tools)
    ? tools.filter((tool) => !(tool?.type === "custom" && shouldBridge(identityOf(tool).name)))
    : tools;
  const visibleNames = providerVisibleToolNames(ordinaryTools);
  const nativeToProvider = new Map();
  const providerToNative = new Map();
  for (const [nativeKey, native] of nativeNames) {
    const wireName = native.namespace === undefined ? native.name : `${native.namespace}${NAMESPACE_DELIMITER}${native.name}`;
    const availableName = availableCustomToolName(wireName, visibleNames);
    const providerName = Number.isInteger(maxNameLength)
      ? reserveSpecialProviderName(
          namespaces,
          `custom:${nativeKey}`,
          availableName,
        )
      : availableName;
    visibleNames.add(providerName);
    nativeToProvider.set(nativeKey, providerName);
    providerToNative.set(providerName, native);
  }
  CUSTOM_TOOL_RELAYS.set(namespaces, providerToNative);

  let changedTools = false;
  const routedTools = Array.isArray(tools)
    ? tools.map((tool) => {
        const providerName =
          tool?.type === "custom" ? nativeToProvider.get(keyOf(identityOf(tool))) : undefined;
        if (!providerName) return tool;
        changedTools = true;
        const description = bridgedCustomToolDescription(tool);
        return {
          type: "function",
          name: providerName,
          ...(description ? { description } : {}),
          parameters: {
            type: "object",
            properties: {
              [CUSTOM_TOOL_INPUT_PROPERTY]: {
                type: "string",
                description: "The complete raw freeform input for this tool, preserved verbatim.",
              },
            },
            required: [CUSTOM_TOOL_INPUT_PROPERTY],
            additionalProperties: false,
          },
        };
      })
    : tools;

  let routedToolChoice = toolChoice;
  const providerChoiceName =
    toolChoice?.type === "custom" ? nativeToProvider.get(keyOf(identityOf(toolChoice))) : undefined;
  if (providerChoiceName) {
    const { namespace: _namespace, ...rest } = toolChoice;
    routedToolChoice = { ...rest, type: "function", name: providerChoiceName };
    SPECIAL_FUNCTION_REFERENCES.add(routedToolChoice);
  } else if (toolChoice?.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    let changed = false;
    const choices = toolChoice.tools.map((choice) => {
      const providerName =
        choice?.type === "custom" ? nativeToProvider.get(keyOf(identityOf(choice))) : undefined;
      if (!providerName) return choice;
      changed = true;
      const { namespace: _namespace, ...rest } = choice;
      const routedChoice = { ...rest, type: "function", name: providerName };
      SPECIAL_FUNCTION_REFERENCES.add(routedChoice);
      return routedChoice;
    });
    if (changed) routedToolChoice = { ...toolChoice, tools: choices };
  }
  const changedToolChoice = routedToolChoice !== toolChoice;

  if (!Array.isArray(input)) {
    return {
      tools: routedTools,
      input,
      toolChoice: routedToolChoice,
      bridged: changedTools || changedToolChoice,
    };
  }
  const bridgedCallIds = new Set();
  let changedInput = false;
  const routedInput = input.map((item) => {
    const providerName =
      item?.type === "custom_tool_call" ? nativeToProvider.get(keyOf(identityOf(item))) : undefined;
    if (providerName && typeof item.input === "string") {
      const { type: _type, input: customInput, name: _name, namespace: _namespace, ...rest } = item;
      if (typeof item.call_id === "string" && item.call_id) {
        bridgedCallIds.add(item.call_id);
      }
      changedInput = true;
      const routedCall = withoutIncompatibleFunctionItemId({
        ...rest,
        type: "function_call",
        name: providerName,
        arguments: JSON.stringify({ [CUSTOM_TOOL_INPUT_PROPERTY]: customInput }),
      });
      SPECIAL_FUNCTION_REFERENCES.add(routedCall);
      return routedCall;
    }
    if (
      item?.type === "custom_tool_call_output" &&
      typeof item.call_id === "string" &&
      bridgedCallIds.has(item.call_id)
    ) {
      changedInput = true;
      return withoutIncompatibleFunctionItemId({ ...item, type: "function_call_output" });
    }
    return item;
  });
  return {
    tools: routedTools,
    input: changedInput ? routedInput : input,
    toolChoice: routedToolChoice,
    bridged: changedTools || changedInput || changedToolChoice,
  };
}

function availableToolSearchName(tools) {
  const names = providerVisibleToolNames(tools);
  if (!names.has(TOOL_SEARCH_FUNCTION_NAME)) return TOOL_SEARCH_FUNCTION_NAME;
  let suffix = 1;
  while (names.has(`codex_tool_search_${suffix}`)) suffix += 1;
  return `codex_tool_search_${suffix}`;
}

function providerToolSearchDescription(description, providerName) {
  if (typeof description !== "string") return undefined;
  if (providerName === TOOL_SEARCH_FUNCTION_NAME) return description;
  const rewritten = description.replaceAll(
    `\`${TOOL_SEARCH_FUNCTION_NAME}\``,
    `\`${providerName}\``,
  );
  return `${rewritten}\n\nFor this routed request, call \`${providerName}\` for deferred tool discovery; \`${TOOL_SEARCH_FUNCTION_NAME}\` is a separate ordinary function.`;
}

function schemaStringValues(schema, values = new Set()) {
  if (!schema || typeof schema !== "object") return values;
  if (typeof schema.const === "string") values.add(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) if (typeof value === "string") values.add(value);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) schemaStringValues(branch, values);
  }
  return values;
}

// A fresh local thread inherits the routed session model when the caller did
// not choose one. Follow-up messages intentionally keep the target thread's
// settings, and cloud tasks require model omission, so neither is rewritten.
const SPAWN_MODEL_TOOLS = new Set(["create_thread"]);
const APP_NAMESPACES = ["mcp__codex_app", "codex_app"];

function isSpawnModelCall(item) {
  if (!item || typeof item.name !== "string") return false;
  // Flattened form the router sends to chat-completions bridges:
  // `codex_app__create_thread`.
  for (const namespace of APP_NAMESPACES) {
    const prefix = `${namespace}${NAMESPACE_DELIMITER}`;
    if (item.name.startsWith(prefix)) {
      return SPAWN_MODEL_TOOLS.has(item.name.slice(prefix.length));
    }
  }
  // Native namespace form openai-responses providers keep:
  // `{ name: "create_thread", namespace: "codex_app" }`.
  if (APP_NAMESPACES.includes(item.namespace)) return SPAWN_MODEL_TOOLS.has(item.name);
  return false;
}

// Inject the session model into local create_thread calls that omitted it.
// `model` is the routed session's model (route.slug). Returns a rewritten
// item when the call is one of SPAWN_MODEL_TOOLS, carries no explicit model,
// and a session model is available; otherwise returns the item untouched.
function injectSessionModelForSpawnCalls(item, model) {
  if (!isSpawnModelCall(item)) return item;
  if (typeof model !== "string" || !model) return item;
  if (typeof item.arguments !== "string") return item;
  if (!jsonArgumentsAreUnambiguous(item.arguments, { allowEmpty: true })) return item;
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return item;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return item;
  if (args.model !== undefined) return item;
  if (args.target?.type === "chatgptWorkCloud") return item;
  return { ...item, arguments: JSON.stringify({ ...args, model }) };
}

const MAX_JSON_CAPTURE_BYTES = 64 * 1024 * 1024;
const CAPTURE_PART_BYTES = 64 * 1024;
const INITIAL_SSE_CAPTURE_PART_BYTES = 1024;
const MAX_TRACKED_OUTPUT_ITEMS = 4096;
const MAX_TRACKED_STATE_BYTES = 8 * 1024 * 1024;
const TRACKED_STATE_FIXED_BYTES = 512;
// Before any semantic output, stop staging an undecided SSE frame before
// downstream response guards lose sight of their own byte ceilings. Once a
// namespace rewrite, suppression, or injection has committed the wire shape,
// a later terminal event may carry the complete response and therefore shares
// the non-streaming JSON capture bound. Crossing either phase's bound releases
// raw bytes before a commit and terminates the stream after one.
const MAX_SSE_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_COMMITTED_SSE_FRAME_BYTES = MAX_JSON_CAPTURE_BYTES;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SSE_EVENT_FIELD = Buffer.from("event", "ascii");
const SSE_DATA_FIELD = Buffer.from("data", "ascii");
const JSON_NUMBER_AT_OFFSET = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function sseFieldValue(line, prefixLength) {
  const value = line.slice(prefixLength);
  // The SSE grammar removes one optional U+0020 after the colon. Tabs,
  // repeated spaces, and trailing spaces are event data, not formatting.
  return value.startsWith(" ") ? value.slice(1) : value;
}

function sseLineFieldValue(line, name) {
  return line === name ? "" : sseFieldValue(line, name.length + 1);
}

function stringFingerprint(value) {
  return {
    length: value.length,
    digest: createHash("sha256").update(value, "utf16le").digest(),
  };
}

function canonicalJsonFingerprint(value) {
  const hash = createHash("sha256");
  let length = 0;
  const update = (part, encoding = "utf8") => {
    hash.update(part, encoding);
    length += Buffer.byteLength(part, encoding);
  };
  const updateString = (marker, text) => {
    update(`${marker}${text.length}:`, "ascii");
    update(text, "utf16le");
  };
  const stack = [{ kind: "value", value }];
  while (stack.length) {
    const frame = stack.pop();
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) {
        update("]", "ascii");
        continue;
      }
      stack.push({ ...frame, index: frame.index + 1 });
      stack.push({ kind: "value", value: frame.value[frame.index] });
      continue;
    }
    if (frame.kind === "object") {
      if (frame.index >= frame.keys.length) {
        update("}", "ascii");
        continue;
      }
      const key = frame.keys[frame.index];
      stack.push({ ...frame, index: frame.index + 1 });
      stack.push({ kind: "value", value: frame.value[key] });
      stack.push({ kind: "key", value: key });
      continue;
    }
    if (frame.kind === "key") {
      updateString("k", frame.value);
      continue;
    }

    const current = frame.value;
    if (current === null) {
      update("n", "ascii");
    } else if (typeof current === "string") {
      updateString("s", current);
    } else if (typeof current === "number") {
      const number = Number.isNaN(current)
        ? "NaN"
        : Object.is(current, -0)
          ? "-0"
          : String(current);
      updateString("d", number);
    } else if (typeof current === "boolean") {
      update(current ? "t" : "f", "ascii");
    } else if (Array.isArray(current)) {
      update(`a${current.length}:[`, "ascii");
      stack.push({ kind: "array", value: current, index: 0 });
    } else if (typeof current === "object") {
      const keys = Object.keys(current).sort();
      update(`o${keys.length}:{`, "ascii");
      stack.push({ kind: "object", value: current, keys, index: 0 });
    } else {
      throw new TypeError("Tool-search arguments contain a non-JSON value.");
    }
  }
  return { length, digest: hash.digest() };
}

function fingerprintMatches(fingerprint, length, digest) {
  return (
    fingerprint.length === length &&
    Buffer.isBuffer(digest) &&
    fingerprint.digest.equals(digest)
  );
}

function trackedStateBytes(state) {
  let bytes = TRACKED_STATE_FIXED_BYTES;
  for (const field of [
    "itemId",
    "callId",
    "sourceType",
    "sourceName",
    "sourceNamespace",
    "outputType",
    "outputName",
    "outputNamespace",
  ]) {
    if (typeof state[field] === "string") bytes += Buffer.byteLength(state[field], "utf8");
  }
  return bytes;
}

// JSON.parse deliberately accepts duplicate object members and keeps the last
// one. That is useful for ordinary application input, but unsafe at a rewrite
// boundary: the bytes can name one tool first and another tool last, while a
// downstream parser is free to make the opposite choice. Parsing also rounds
// unsafe integers and accepts overflowing exponents that stringify as null.
// Audit the complete JSON grammar before parsing, compare decoded key values
// so spellings such as `"name"` and `"\u006eame"` collide, and reject numeric
// values whose parse/stringify semantics are known to be lossy.
export function jsonIsUnambiguousForRewrite(text, { allowLossyNumbers = false } = {}) {
  if (typeof text !== "string") return false;
  let offset = 0;

  const skipWhitespace = () => {
    while (
      offset < text.length &&
      (text[offset] === " " ||
        text[offset] === "\t" ||
        text[offset] === "\r" ||
        text[offset] === "\n")
    ) {
      offset += 1;
    }
  };

  const stringToken = () => {
    if (text[offset] !== '"') return undefined;
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        return text.slice(start, offset);
      }
      if (code < 0x20) return undefined;
      if (character !== "\\") {
        offset += 1;
        continue;
      }
      offset += 1;
      const escape = text[offset];
      if (escape === "u") {
        const digits = text.slice(offset + 1, offset + 5);
        if (digits.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(digits)) return undefined;
        offset += 5;
        continue;
      }
      if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) {
        return undefined;
      }
      offset += 1;
    }
    return undefined;
  };

  const literal = (value) => {
    if (!text.startsWith(value, offset)) return false;
    offset += value.length;
    return true;
  };

  const number = () => {
    JSON_NUMBER_AT_OFFSET.lastIndex = offset;
    const match = JSON_NUMBER_AT_OFFSET.exec(text);
    if (!match) return false;
    // Turn metadata is inspected only for string/bool namespace identities and
    // is never reserialized here. Its unrelated numeric fields may therefore
    // be lossy without changing the identity decision. Duplicate object keys
    // remain forbidden in every mode: JSON.parse's last-wins behavior would
    // otherwise let ambiguous metadata hide an ordinary-function collision.
    if (!allowLossyNumbers && !jsonNumberIsStableForRewrite(match[0])) return false;
    offset = JSON_NUMBER_AT_OFFSET.lastIndex;
    return true;
  };

  const value = () => {
    skipWhitespace();
    const character = text[offset];
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') return stringToken() !== undefined;
    if (character === "t") return literal("true");
    if (character === "f") return literal("false");
    if (character === "n") return literal("null");
    return number();
  };

  const object = () => {
    offset += 1;
    skipWhitespace();
    if (text[offset] === "}") {
      offset += 1;
      return true;
    }
    const keys = new Set();
    while (offset < text.length) {
      skipWhitespace();
      const token = stringToken();
      if (token === undefined) return false;
      let key;
      try {
        key = JSON.parse(token);
      } catch {
        return false;
      }
      if (keys.has(key)) return false;
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ":") return false;
      offset += 1;
      if (!value()) return false;
      skipWhitespace();
      if (text[offset] === "}") {
        offset += 1;
        return true;
      }
      if (text[offset] !== ",") return false;
      offset += 1;
    }
    return false;
  };

  const array = () => {
    offset += 1;
    skipWhitespace();
    if (text[offset] === "]") {
      offset += 1;
      return true;
    }
    while (offset < text.length) {
      if (!value()) return false;
      skipWhitespace();
      if (text[offset] === "]") {
        offset += 1;
        return true;
      }
      if (text[offset] !== ",") return false;
      offset += 1;
    }
    return false;
  };

  try {
    if (!value()) return false;
    skipWhitespace();
    return offset === text.length;
  } catch {
    // Excessive nesting and any other scanner failure are ambiguity, not
    // permission to fall back to JSON.parse's lossy interpretation.
    return false;
  }
}

function jsonArgumentsAreUnambiguous(value, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return true;
  if (allowEmpty && value.trim() === "") return true;
  return jsonIsUnambiguousForRewrite(value);
}

// Repair the parameter roots needed by the GLM bridge. An ordinary root keeps
// its identity and costs no copy.
function repairToolSchemaRoot(tool) {
  const parameters = tool?.function?.parameters ?? tool?.parameters;
  if (parameters === undefined) return tool;
  const repaired = providerToolSchema(parameters);
  if (repaired === parameters) return tool;
  return tool.function
    ? { ...tool, function: { ...tool.function, parameters: repaired } }
    : { ...tool, parameters: repaired };
}

function flattenNamespaceChild(namespace, fn, providerName) {
  const clientSchema = fn.parameters ?? fn.inputSchema;
  const parameters =
    clientSchema === undefined ? undefined : providerToolSchema(clientSchema);
  const flattened = {
    ...fn,
    name: providerName ?? `${namespace}${NAMESPACE_DELIMITER}${fn.name}`,
    ...(parameters === undefined ? {} : { parameters }),
  };
  if (fn.type === "custom") CUSTOM_TOOL_IDENTITIES.set(flattened, { namespace, name: fn.name });
  return flattened;
}

// Flatten every namespace entry into plain functions named
// `<namespace>__<tool>`. Returns the set of namespaces that were flattened
// (name -> tool names) so callers can rename history and restore calls.
export function flattenNamespaceTools(
  tools,
  { bridgeToolSearch = true, maxNameLength, aliasCollisions = false } = {},
) {
  if (!Array.isArray(tools)) return { tools, flattened: false, namespaces: new Map() };
  const flattened = [];
  const namespaces = new Map();
  const plainToolNames = new Set();
  PLAIN_TOOL_NAMES.set(namespaces, plainToolNames);
  initializeNameAliases(namespaces, tools, maxNameLength, aliasCollisions);
  const spawnAgentModels = new Set();
  const toolSearchName = bridgeToolSearch
    ? reserveSpecialProviderName(
        namespaces,
        "tool-search",
        availableToolSearchName(tools),
      )
    : undefined;
  let toolSearchRelay;
  let changed = false;
  for (const tool of tools) {
    // Codex registers deferred tools client-side and exposes this native
    // control so the model can search them on demand. Chat-completions
    // providers reject the native type, so present the same request-local
    // capability as an ordinary function and restore its calls on the
    // response path. Only the native client-executed shape enables the relay;
    // an unrelated function named `tool_search` never does. When such a plain
    // function already exists, use a deterministic alias so neither call can
    // hijack the other.
    if (tool?.type === "tool_search") {
      changed = true;
      if (bridgeToolSearch && tool.execution === "client" && !toolSearchRelay) {
        const parameters =
          tool.parameters === undefined ? undefined : providerToolSchema(tool.parameters);
        const description = providerToolSearchDescription(tool.description, toolSearchName);
        flattened.push({
          type: "function",
          name: toolSearchName,
          ...(description === undefined ? {} : { description }),
          ...(parameters === undefined ? {} : { parameters }),
        });
        toolSearchRelay = { providerName: toolSearchName };
      }
      continue;
    }
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      const names = new Set();
      for (const fn of tool.tools) {
        if (!fn?.name) continue;
        // Codex names function schemas `inputSchema`, while LiteLLM's
        // Responses -> Chat Completions adapter reads only `parameters`.
        // Without this alias every flattened namespace child reaches the
        // provider as an empty object schema, so MCP calls cannot receive the
        // arguments their server requires. Keep inputSchema too: it is the
        // client's native representation and responses-native routes retain
        // it untouched.
        //
        // The GLM bridge rejects the whole request over a union-rooted
        // parameter schema or an enum literal that contradicts its type. Codex's
        // `codex_app__automation_update` ships a `oneOf` root, so a session that
        // never touches automations still dies on its first message. Normalize
        // only the provider-facing copy; `inputSchema` stays exactly as the
        // client sent it.
        flattened.push(
          flattenNamespaceChild(
            tool.name,
            fn,
            providerNameForNative(namespaces, tool.name, fn.name),
          ),
        );
        names.add(fn.name);
        if (tool.name === "collaboration" && fn.name === "spawn_agent") {
          schemaStringValues(fn.inputSchema?.properties?.model, spawnAgentModels);
        }
      }
      if (names.size > 0) {
        namespaces.set(tool.name, names);
        changed = true;
      }
      continue;
    }
    // Plain functions need the same root repair as namespaced functions.
    // `providerToolSchema` returns an ordinary root unchanged.
    let repaired = repairToolSchemaRoot(tool);
    const name = tool?.type === "function" ? providerFunctionName(repaired) : undefined;
    if (typeof name === "string" && name) {
      const providerName = providerNameForNative(namespaces, undefined, name);
      if (providerName !== name) repaired = withProviderFunctionName(repaired, providerName);
      plainToolNames.add(providerName);
    }
    if (repaired !== tool) changed = true;
    flattened.push(repaired);
  }
  if (spawnAgentModels.size > 0) SPAWN_AGENT_MODELS.set(namespaces, spawnAgentModels);
  if (toolSearchRelay) TOOL_SEARCH_RELAYS.set(namespaces, toolSearchRelay);
  return { tools: flattened, flattened: changed, namespaces };
}

// A Codex custom-provider request can arrive with MCP or harness tools already
// flattened. In that shape the tool list no longer contains a
// `type: "namespace"` entry, so flattenNamespaceTools cannot build the reverse
// map needed when the provider returns the ordinary function call. Codex keeps
// the canonical native identities in its reserved turn metadata. Recover only
// direct function/custom declarations whose exact spelling is in this request.
//
// The metadata also inventories ordinary functions under the default
// `functions` namespace. Treat that entry, and any delimiter collision between
// two native identities, as ambiguous rather than reinterpreting a legitimate
// plain function as an MCP call. Keep this recovery MCP-scoped: app and
// collaboration tools carry additional router-side behavior that a bare name
// map cannot reconstruct safely.
export function restorePreflattenedToolNamespaces(tools, clientMetadata) {
  if (!Array.isArray(tools)) return tools;
  const encoded = clientMetadata?.["x-codex-turn-metadata"];
  if (typeof encoded !== "string" ||
      !jsonIsUnambiguousForRewrite(encoded, { allowLossyNumbers: true })) return tools;
  let metadata;
  try {
    metadata = JSON.parse(encoded);
  } catch {
    return tools;
  }
  const inventory = metadata?.tool_namespaces_info;
  if (!plainObject(inventory)) return tools;

  // Default-namespace entries are already plain tools. Never reinterpret a
  // literal name containing __ merely because another namespace claims it.
  const ordinaryNames = new Set();
  if (Object.hasOwn(inventory, DEFAULT_FUNCTION_NAMESPACE)) {
    const ordinary = inventory[DEFAULT_FUNCTION_NAMESPACE];
    if (ordinary?.name !== DEFAULT_FUNCTION_NAMESPACE ||
        !plainObject(ordinary.functions)) return tools;
    for (const [name, info] of Object.entries(ordinary.functions)) {
      if (!name || !plainObject(info) || info.name !== name) return tools;
      ordinaryNames.add(name);
    }
  }

  const candidates = new Map();
  const remember = (wireName, native) => {
    if (!candidates.has(wireName)) {
      candidates.set(wireName, native);
      return;
    }
    const previous = candidates.get(wireName);
    if (!previous || previous.namespace !== native.namespace ||
        previous.name !== native.name) candidates.set(wireName, undefined);
  };
  for (const [namespace, namespaceInfo] of Object.entries(inventory)) {
    if (!namespace || namespace === DEFAULT_FUNCTION_NAMESPACE ||
        namespaceInfo?.name !== namespace || !plainObject(namespaceInfo.functions)) continue;
    for (const [name, info] of Object.entries(namespaceInfo.functions)) {
      const mcp = info?.source?.kind === "mcp" &&
        typeof info.source.server_name === "string" && info.source.server_name &&
        namespace === `${MCP_NAMESPACE_PREFIX}${info.source.server_name}`;
      if (!name || info?.name !== name || info.direct !== true ||
          (!mcp && info.source?.kind !== "harness")) continue;
      remember(`${namespace}${NAMESPACE_DELIMITER}${name}`, { namespace, name });
    }
  }

  const existingNamespaces = new Map();
  const existingIdentities = new Set();
  const repeatedNamespaces = new Set();
  const declarations = new Map();
  for (const tool of tools) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      if (existingNamespaces.has(tool.name)) repeatedNamespaces.add(tool.name);
      existingNamespaces.set(tool.name, tool);
      for (const child of tool.tools) {
        if (typeof child?.name !== "string" || !child.name) continue;
        remember(`${tool.name}${NAMESPACE_DELIMITER}${child.name}`,
          { namespace: tool.name, name: child.name });
        existingIdentities.add(nativeToolKey(tool.name, child.name));
      }
    } else if (tool?.type === "function" || tool?.type === "custom") {
      const name = providerFunctionName(tool);
      // Metadata has no function/custom discriminator. Repeated wire names
      // cannot be safely assigned to one declaration, even across those types.
      declarations.set(name, declarations.has(name) ? undefined : tool);
    }
  }

  const recovered = new Map();
  const groups = new Map();
  for (const [wireName, native] of candidates) {
    const tool = declarations.get(wireName);
    if (!native || !tool || ordinaryNames.has(wireName) ||
        repeatedNamespaces.has(native.namespace) ||
        existingIdentities.has(nativeToolKey(native.namespace, native.name))) continue;
    recovered.set(tool, native);
    if (!groups.has(native.namespace)) {
      const existing = existingNamespaces.get(native.namespace);
      groups.set(native.namespace, existing
        ? { ...existing, tools: [] }
        : { type: "namespace", name: native.namespace, tools: [] });
    }
  }
  if (!recovered.size) return tools;

  // One declaration per namespace lets app expansion prefer the complete client
  // schema without injecting the same deferred snapshot into multiple fragments.
  const restored = [];
  const emitted = new Set();
  for (const tool of tools) {
    const native = recovered.get(tool);
    const group = native ? groups.get(native.namespace)
      : tool?.type === "namespace" ? groups.get(tool.name) : undefined;
    if (!group) {
      restored.push(tool);
      continue;
    }
    if (!emitted.has(group)) {
      emitted.add(group);
      restored.push(group);
    }
    if (native) {
      const { function: definition, ...rest } = tool;
      group.tools.push({ ...rest, ...definition, name: native.name });
    } else {
      group.tools.push(...tool.tools);
    }
  }
  return restored;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function validToolSearchHistoryArguments(value) {
  const argumentsObject = plainObject(value);
  if (!argumentsObject || typeof argumentsObject.query !== "string") return false;
  if (!argumentsObject.query.trim()) return false;
  const { limit } = argumentsObject;
  return limit === undefined || (Number.isInteger(limit) && limit > 0);
}

function discoveredProviderTools(toolSpecs, namespaces) {
  if (!Array.isArray(toolSpecs)) return [];
  const discovered = [];
  for (const tool of toolSpecs) {
    if (tool?.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const fn of tool.tools) {
        if (fn?.type !== "function" || !fn.name) continue;
        discovered.push({
          tool: flattenNamespaceChild(
            tool.name,
            fn,
            providerNameForNative(namespaces, tool.name, fn.name),
          ),
          native: { namespace: tool.name, name: fn.name },
          nativeName: fn.name,
          identity: nativeToolKey(tool.name, fn.name),
        });
      }
      continue;
    }
    if (tool?.type !== "function" || !providerFunctionName(tool)) continue;
    const nativeName = providerFunctionName(tool);
    const providerName = providerNameForNative(namespaces, undefined, nativeName);
    let providerTool = repairToolSchemaRoot(tool);
    if (providerName !== nativeName) {
      providerTool = withProviderFunctionName(providerTool, providerName);
    }
    discovered.push({
      tool: providerTool,
      nativeName,
      identity: nativeToolKey(undefined, nativeName),
    });
  }
  return discovered;
}

function addDiscoveredNamespace(namespaces, native) {
  if (!native) return;
  let names = namespaces.get(native.namespace);
  if (!names) {
    names = new Set();
    namespaces.set(native.namespace, names);
  }
  names.add(native.name);
}

export class ToolSearchHistoryCapacityError extends Error {
  constructor({ available, required }) {
    super(
      `Stored tool_search history references ${required} discovered tools, but only ` +
        `${available} provider tool slots remain.`,
    );
    this.name = "ToolSearchHistoryCapacityError";
    this.available = available;
    this.required = required;
  }
}

// A native tool_search output changes what the model may call on the next
// turn. The Responses API understands that special history item directly;
// LiteLLM's chat-completions bridge does not. Translate matched call/output
// pairs into ordinary function history and add the returned definitions to
// this request's provider-facing tool list. A model switch may leave no live
// search relay; in that explicitly enabled mode, preserve the definitions but
// drop the now-unusable native control pair. Live top-level schemas win on a
// name collision. Native items that do not form one unique, ordered,
// well-formed pair are dropped: a chat-completions provider cannot consume
// them, and forwarding one would make the transcript promise unavailable
// tools.
export function flattenToolSearchHistory(
  input,
  tools,
  namespaces,
  { maxTools = Infinity, recoverWithoutRelay = false, toolChoice } = {},
) {
  const relay = TOOL_SEARCH_RELAYS.get(namespaces);
  if (!Array.isArray(input)) {
    return { input, tools, flattened: false };
  }
  if (!Array.isArray(tools)) {
    const routedInput = input.filter(
      (item) => item?.type !== "tool_search_call" && item?.type !== "tool_search_output",
    );
    return {
      input: routedInput.length === input.length ? input : routedInput,
      tools,
      flattened: routedInput.length !== input.length,
    };
  }

  const callsById = new Map();
  const invalidIds = new Set();
  let nativeItems = 0;
  // Pair in one forward walk. Outputs may follow several parallel calls, but
  // they may never reach backwards past an orphan, duplicate, or malformed
  // item with the same id. Records are materialized only after the walk, so a
  // duplicate discovered late invalidates the entire id before any tool can be
  // added to the provider request.
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const isCall = item?.type === "tool_search_call";
    const isOutput = item?.type === "tool_search_output";
    if (!isCall && !isOutput) continue;
    nativeItems += 1;

    const id = typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
    if (!id) continue;
    if (invalidIds.has(id)) continue;

    if (isCall) {
      const valid =
        item.execution === "client" && validToolSearchHistoryArguments(item.arguments);
      if (!valid || callsById.has(id)) {
        callsById.delete(id);
        invalidIds.add(id);
        continue;
      }
      callsById.set(id, { call: item, callIndex: index });
      continue;
    }

    const call = callsById.get(id);
    const valid =
      item.execution === "client" &&
      item.status === "completed" &&
      Array.isArray(item.tools);
    if (!valid || !call || call.output) {
      callsById.delete(id);
      invalidIds.add(id);
      continue;
    }
    call.output = item;
    call.outputIndex = index;
  }

  if (nativeItems === 0) return { input, tools, flattened: false };

  const callsByIndex = new Map();
  const outputsByIndex = new Map();
  if (relay || recoverWithoutRelay) {
    for (const [id, record] of callsById) {
      if (!record.output || invalidIds.has(id)) continue;
      callsByIndex.set(record.callIndex, record);
      outputsByIndex.set(record.outputIndex, record);
    }
  }

  const toolCapacity = Number.isInteger(maxTools) && maxTools >= 0 ? maxTools : Infinity;
  const remainingToolCapacity = Math.max(0, toolCapacity - tools.length);
  const visibleNames = providerVisibleToolNames(tools);
  const initialNameAliases = new Map(
    NAME_ALIASES.get(namespaces)?.nativeToProvider || [],
  );
  const definitionOwnersByName = new Map();
  const discoveries = [];
  const discoveriesByOutputIndex = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!outputsByIndex.has(index)) continue;
    const records = [];
    for (const candidate of discoveredProviderTools(item.tools, namespaces)) {
      const name = providerFunctionName(candidate.tool);
      if (!name) continue;
      const priorOwner = definitionOwnersByName.get(name);
      const shadowedByClient = visibleNames.has(name) && !priorOwner;
      const record = {
        ...candidate,
        name,
        outputIndex: index,
        shadowed: shadowedByClient || priorOwner !== undefined,
        definitionOwner: shadowedByClient ? undefined : priorOwner,
      };
      if (!visibleNames.has(name)) {
        visibleNames.add(name);
        definitionOwnersByName.set(name, record);
        record.definitionOwner = record;
      }
      discoveries.push(record);
      records.push(record);
    }
    discoveriesByOutputIndex.set(index, records);
  }

  // A bounded provider surface may omit only unused discoveries. Resolve each
  // stored call against the definitions that existed at that point in the
  // transcript, using the same precedence as flattenNamespacedHistory: an
  // explicit namespace is exact, an exact plain native identity wins over a
  // stale flattened namespace spelling, then provider aliases/raw namespace
  // spellings, then a unique bare namespace name. Later discoveries must not
  // retroactively make an earlier bare call ambiguous. A forced tool choice is
  // evaluated after all stored discoveries and reserves its schema too.
  const CURRENT_DEFINITION = Symbol("current-tool-definition");
  const identityOwners = new Map();
  const plainNativeOwners = new Map();
  const providerOwners = new Map();
  const wireNamespaceOwners = new Map();
  const bareNamespaceOwners = new Map();
  const addOwner = (owners, name, owner) => {
    if (typeof name !== "string" || !name) return;
    if (!owners.has(name)) owners.set(name, new Set());
    owners.get(name).add(owner);
  };
  const uniqueOwner = (owners) => owners?.size === 1 ? [...owners][0] : undefined;
  const rememberIdentity = ({ identity, native, nativeName, name, owner }) => {
    if (!identityOwners.has(identity)) identityOwners.set(identity, owner);
    addOwner(providerOwners, name, identity);
    if (native) {
      addOwner(
        wireNamespaceOwners,
        `${native.namespace}${NAMESPACE_DELIMITER}${native.name}`,
        identity,
      );
      addOwner(bareNamespaceOwners, native.name, identity);
    } else {
      addOwner(plainNativeOwners, nativeName, identity);
    }
  };

  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      rememberIdentity({
        identity: nativeToolKey(namespace, name),
        native: { namespace, name },
        name: providerNameForNative(namespaces, namespace, name),
        owner: CURRENT_DEFINITION,
      });
    }
  }
  if (initialNameAliases.size) {
    for (const [identity, providerName] of initialNameAliases) {
      let decoded;
      try {
        decoded = JSON.parse(identity);
      } catch {
        continue;
      }
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== null) continue;
      rememberIdentity({
        identity,
        nativeName: decoded[1],
        name: providerName,
        owner: CURRENT_DEFINITION,
      });
    }
  } else {
    for (const name of PLAIN_TOOL_NAMES.get(namespaces) || []) {
      rememberIdentity({
        identity: nativeToolKey(undefined, name),
        nativeName: name,
        name,
        owner: CURRENT_DEFINITION,
      });
    }
  }
  // Custom/tool-search relays are provider-visible but are never ordinary
  // discovered definitions. Reserve their spellings as current identities so
  // a matching model-visible name cannot be attributed to a discovery.
  for (const name of CUSTOM_TOOL_RELAYS.get(namespaces)?.keys() || []) {
    const identity = `special:custom:${name}`;
    identityOwners.set(identity, CURRENT_DEFINITION);
    addOwner(providerOwners, name, identity);
  }
  const toolSearch = TOOL_SEARCH_RELAYS.get(namespaces);
  if (toolSearch) {
    const identity = "special:tool-search";
    identityOwners.set(identity, CURRENT_DEFINITION);
    addOwner(providerOwners, toolSearch.providerName, identity);
  }

  const referencedDefinitions = new Set();
  const referencedIdentities = new Set();
  const markReference = (reference) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) return;
    const nestedName = reference.function?.name;
    const name = typeof nestedName === "string" ? nestedName : reference.name;
    if (typeof name !== "string" || !name) return;
    const namespace =
      typeof reference.namespace === "string" && reference.namespace
        ? reference.namespace
        : undefined;
    let identity;
    if (namespace) {
      const exact = nativeToolKey(namespace, name);
      if (identityOwners.has(exact)) identity = exact;
    } else if (!SPECIAL_FUNCTION_REFERENCES.has(reference)) {
      identity = uniqueOwner(plainNativeOwners.get(name));
      identity ??= uniqueOwner(providerOwners.get(name));
      identity ??= uniqueOwner(wireNamespaceOwners.get(name));
      identity ??= uniqueOwner(bareNamespaceOwners.get(name));
    }
    if (!identity) return;
    referencedIdentities.add(identity);
    const owner = identityOwners.get(identity);
    if (owner && owner !== CURRENT_DEFINITION) referencedDefinitions.add(owner);
  };
  const discoveriesByIndex = new Map();
  for (const discovery of discoveries) {
    if (!discoveriesByIndex.has(discovery.outputIndex)) {
      discoveriesByIndex.set(discovery.outputIndex, []);
    }
    discoveriesByIndex.get(discovery.outputIndex).push(discovery);
  }
  for (let index = 0; index < input.length; index += 1) {
    for (const discovery of discoveriesByIndex.get(index) || []) {
      const owner = discovery.definitionOwner || CURRENT_DEFINITION;
      rememberIdentity({ ...discovery, owner });
    }
    const item = input[index];
    if (item?.type === "function_call") markReference(item);
  }
  if (toolChoice?.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    for (const choice of toolChoice.tools) {
      if (choice?.type === "function") markReference(choice);
    }
  } else if (toolChoice?.type === "function") {
    markReference(toolChoice);
  }
  const requiredDefinitions = [...referencedDefinitions];
  if (requiredDefinitions.length > remainingToolCapacity) {
    throw new ToolSearchHistoryCapacityError({
      available: remainingToolCapacity,
      required: requiredDefinitions.length,
    });
  }
  const acceptedDiscoveries = new Set(requiredDefinitions);
  for (const discovery of discoveries) {
    if (acceptedDiscoveries.size >= remainingToolCapacity) break;
    if (discovery.shadowed) continue;
    acceptedDiscoveries.add(discovery);
  }

  let routedTools = tools;
  const routedInput = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item?.type === "tool_search_call") {
      if (!callsByIndex.has(index)) continue;
      if (!relay) continue;
      const {
        type: _type,
        execution: _execution,
        status: _status,
        arguments: searchArguments,
        ...rest
      } = item;
      const routedCall = {
        ...rest,
        type: "function_call",
        name: relay.providerName,
        arguments: JSON.stringify(searchArguments),
      };
      SPECIAL_FUNCTION_REFERENCES.add(routedCall);
      routedInput.push(routedCall);
      continue;
    }

    if (item?.type !== "tool_search_output") {
      routedInput.push(item);
      continue;
    }
    if (!outputsByIndex.has(index)) continue;

    const accepted = [];
    for (const discovery of discoveriesByOutputIndex.get(index) || []) {
      if (acceptedDiscoveries.has(discovery)) {
        accepted.push(discovery.tool);
        addDiscoveredNamespace(namespaces, discovery.native);
        if (!discovery.native) PLAIN_TOOL_NAMES.get(namespaces)?.add(discovery.name);
      } else if (
        recoverWithoutRelay &&
        discovery.shadowed &&
        referencedIdentities.has(discovery.identity)
      ) {
        // A current client definition owns the provider-visible name and its
        // schema must win. The stored native identity is still needed to
        // flatten the later historical call and restore any repeated call.
        addDiscoveredNamespace(namespaces, discovery.native);
      }
    }
    // Keep the live-name set across outputs. The first valid discovery wins;
    // later outputs omit a duplicate from both their result and the request's
    // tool list instead of advertising a schema that cannot take precedence.
    if (accepted.length) {
      if (routedTools === tools) routedTools = [...tools];
      routedTools.push(...accepted);
    }

    // The current provider cannot execute a fresh native tool_search call.
    // Preserve the discovered definitions above, but remove the now-unusable
    // call/output control pair from the chat-completions transcript.
    if (!relay) continue;

    const {
      type: _type,
      execution: _execution,
      status: _status,
      tools: _tools,
      ...rest
    } = item;
    routedInput.push({
      ...rest,
      type: "function_call_output",
      output: JSON.stringify({ tools: accepted }),
    });
  }

  return {
    input: routedInput,
    tools: routedTools,
    flattened: true,
  };
}

// Flattening only the tool list leaves the model reading two names for one
// tool: `collaboration__spawn_agent` in its tools, but a bare `spawn_agent`
// in its own call history, because LiteLLM's bridge drops the `namespace`
// field when it converts stored function calls to Chat Completions tool calls.
// The model imitates the history, emits the bare name, nothing rewrites it,
// and Codex answers `unsupported call` -- permanently, since every failure
// adds another bare example. Rename the history to match the flattened tools.
export function flattenNamespacedHistory(input, namespaces) {
  const nameRelay = NAME_ALIASES.get(namespaces);
  if (!Array.isArray(input) || (namespaces.size === 0 && !nameRelay)) return input;
  const flattenedNames = new Set();
  const bareOwners = new Map();
  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      flattenedNames.add(`${namespace}${NAMESPACE_DELIMITER}${name}`);
      if (!bareOwners.has(name)) bareOwners.set(name, new Set());
      bareOwners.get(name).add(namespace);
    }
  }
  const providerNames = new Set([
    ...(PLAIN_TOOL_NAMES.get(namespaces) || []),
    ...(nameRelay?.providerToNative.keys() || []),
    ...(nameRelay?.plainProviderNames || []),
    ...(CUSTOM_TOOL_RELAYS.get(namespaces)?.keys() || []),
  ]);
  const toolSearch = TOOL_SEARCH_RELAYS.get(namespaces);
  if (toolSearch) providerNames.add(toolSearch.providerName);
  return input.map((item) => {
    if (item?.type !== "function_call") return item;
    const { name } = item;
    if (typeof name !== "string") return item;
    // The client stores namespaced calls as { name, namespace }.
    const namespace = item.namespace;
    if (typeof namespace === "string" && namespaces.get(namespace)?.has(name)) {
      const { namespace: _namespace, ...rest } = item;
      return { ...rest, name: providerNameForNative(namespaces, namespace, name) };
    }
    // A custom/tool-search call already bridged in this request owns its exact
    // provider spelling. A later-discovered ordinary function can have the same
    // native name but a different provider alias; object identity keeps the two
    // histories distinct after both have become ordinary function calls.
    if (SPECIAL_FUNCTION_REFERENCES.has(item)) return item;
    // A plain native function may have the exact spelling a namespace child
    // would normally flatten to (for example plain `a__b` beside namespace
    // `a` / child `b`). Both definitions receive collision aliases. Resolve
    // the exact plain identity before treating that spelling as a raw
    // namespace wire name, or stored plain history would cite neither alias.
    const plainProviderName =
      namespace === undefined
        ? nameRelay?.nativeToProvider.get(nativeToolKey(undefined, name))
        : undefined;
    if (plainProviderName && plainProviderName !== name) {
      return { ...item, name: plainProviderName };
    }
    // Provider-visible plain and special-relay names take precedence only when
    // history carries no valid native namespace or exact aliased plain identity.
    // Otherwise a plain `read` tool could prevent `{ namespace: "mcp", name:
    // "read" }` from being rewritten to the namespaced definition actually sent
    // upstream.
    if (providerNames.has(name)) return item;
    if (flattenedNames.has(name)) {
      const providerName = providerNameForWire(namespaces, name);
      return providerName && providerName !== name ? { ...item, name: providerName } : item;
    }
    // Calls stored without a namespace field whose bare name belongs to
    // exactly one flattened namespace.
    if (namespace === undefined) {
      const owners = bareOwners.get(name);
      if (owners && owners.size === 1) {
        const [owner] = [...owners];
        const { namespace: _namespace, ...rest } = item;
        return { ...rest, name: providerNameForNative(namespaces, owner, name) };
      }
    }
    return item;
  });
}

export function flattenNamespacedToolChoice(choice, namespaces) {
  if (choice?.type === "allowed_tools" && Array.isArray(choice.tools)) {
    return { ...choice, tools: choice.tools.map(tool => flattenNamespacedToolChoice(tool, namespaces)) };
  }
  if (choice?.type !== "function") return choice;
  const [reference] = flattenNamespacedHistory([{ ...choice, type: "function_call" }], namespaces);
  return { ...reference, type: "function" };
}

// A rejected, undeclared native call can remain in persisted history. Some
// providers reject punctuation in that name even though no such tool is
// enabled. Alias its wire spelling without deleting the attempt/result or
// inventing a declaration. The existing reverse map preserves native identity
// if the model repeats it; Codex still decides whether the call is available.
export function aliasHistoricalFunctionNames(input, namespaces) {
  if (!Array.isArray(input)) return input;
  const declaredNames = new Set([
    ...(PLAIN_TOOL_NAMES.get(namespaces) || []),
    ...(CUSTOM_TOOL_RELAYS.get(namespaces)?.keys() || []),
    ...[...namespaces].flatMap(([namespace, names]) => [...names].map(name => `${namespace}${NAMESPACE_DELIMITER}${name}`)),
  ]);
  const search = TOOL_SEARCH_RELAYS.get(namespaces);
  if (search) declaredNames.add(search.providerName);
  const invalid = input.filter(item => item?.type === "function_call" &&
    !SPECIAL_FUNCTION_REFERENCES.has(item) && !declaredNames.has(item.name) &&
    typeof item.name === "string" && !/^[a-zA-Z0-9_-]{1,64}$/.test(item.name));
  if (!invalid.length) return input;
  const relay = NAME_ALIASES.get(namespaces) || initializeNameAliases(namespaces, [], 64);
  for (const name of declaredNames) {
    if (!relay.providerOwners.has(name)) relay.providerOwners.set(name, `declared:${name}`);
  }
  // Reserve valid historical names too, including tools no longer declared.
  for (const item of input) {
    if (item?.type === "function_call" && typeof item.name === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(item.name) && !relay.providerOwners.has(item.name)) {
      relay.providerOwners.set(item.name, nativeToolKey(item.namespace, item.name));
    }
  }
  const aliases = new Map();
  for (const item of [...invalid].sort((a, b) => nativeToolKey(a.namespace, a.name).localeCompare(nativeToolKey(b.namespace, b.name)))) {
    const identity = nativeToolKey(item.namespace, item.name);
    const wireName = item.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "historical_tool";
    aliases.set(identity, assignProviderName(relay, identity, wireName,
      { name: item.name, ...(item.namespace === undefined ? {} : { namespace: item.namespace }) }, { forceAlias: true }));
  }
  return input.map(item => {
    if (item?.type !== "function_call") return item;
    const name = aliases.get(nativeToolKey(item.namespace, item.name));
    if (!name) return item;
    const { namespace: _namespace, ...rest } = item;
    return { ...rest, name };
  });
}

// Reverse lookups for restoring calls: flattened name -> native
// { namespace, name }, and bare tool name -> namespaces that own it.
export function buildNamespaceLookups(namespaces) {
  const flatToNative = new Map();
  const bareToNamespaces = new Map();
  const nameAliases = NAME_ALIASES.get(namespaces);
  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      const providerName =
        nameAliases?.nativeToProvider.get(nativeToolKey(namespace, name)) ||
        `${namespace}${NAMESPACE_DELIMITER}${name}`;
      flatToNative.set(providerName, {
        namespace,
        name,
      });
      if (!bareToNamespaces.has(name)) bareToNamespaces.set(name, new Set());
      bareToNamespaces.get(name).add(namespace);
    }
  }
  if (nameAliases) {
    for (const [providerName, native] of nameAliases.providerToNative) {
      flatToNative.set(providerName, native);
    }
  }
  return {
    flatToNative,
    bareToNamespaces,
    plainToolNames: new Set([
      ...(PLAIN_TOOL_NAMES.get(namespaces) || []),
      ...(nameAliases?.plainProviderNames || []),
    ]),
    identityAliases: Boolean(nameAliases),
    spawnAgentModels: SPAWN_AGENT_MODELS.get(namespaces),
    toolSearch: TOOL_SEARCH_RELAYS.get(namespaces),
    customTools: CUSTOM_TOOL_RELAYS.get(namespaces),
  };
}

function sanitizeSpawnAgentModel(item, lookups) {
  if (item?.namespace !== "collaboration" || item.name !== "spawn_agent") return item;
  const allowed = lookups.spawnAgentModels;
  if (!(allowed instanceof Set) || allowed.size === 0 || typeof item.arguments !== "string") {
    return item;
  }
  if (!jsonArgumentsAreUnambiguous(item.arguments)) return item;
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return item;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return item;
  if (typeof args.model !== "string" || allowed.has(args.model)) return item;
  const { model: _invalidModel, ...safeArgs } = args;
  return { ...item, arguments: JSON.stringify(safeArgs) };
}

// Restore one SSE event's function call to the client's native namespace
// shape. A flattened `<namespace>__<tool>` name resolves exactly. A bare tool
// name (some models emit the unqualified form) is restored only when it is
// unambiguous across every flattened namespace; a collision stays untouched
// rather than guessing which runtime owns it.
function rewriteFunctionCallArguments(item) {
  if (!item || typeof item !== "object") return item;
  if (!jsonArgumentsAreUnambiguous(item.arguments, { allowEmpty: true })) return item;
  const argumentsText = coerceFunctionCallArguments(item.arguments);
  if (argumentsText === item.arguments) return item;
  return { ...item, arguments: argumentsText };
}

function toolSearchArguments(value, allowPlaceholder) {
  if (plainObject(value)) return value;
  if (typeof value !== "string") return undefined;
  if (allowPlaceholder && value.trim() === "") return {};
  if (!jsonArgumentsAreUnambiguous(value)) return undefined;
  try {
    return plainObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function rewriteToolSearchFunctionCallItem(item, lookups, allowPlaceholder) {
  const relay = lookups.toolSearch;
  if (
    !relay ||
    item?.type !== "function_call" ||
    item.name !== relay.providerName ||
    item.namespace !== undefined ||
    typeof item.call_id !== "string" ||
    !item.call_id
  ) {
    return undefined;
  }
  const argumentsObject = toolSearchArguments(item.arguments, allowPlaceholder);
  if (!argumentsObject) return undefined;
  const {
    type: _type,
    name: _name,
    namespace: _namespace,
    arguments: _arguments,
    encrypted_function_args: _encryptedFunctionArgs,
    ...rest
  } = item;
  return {
    ...rest,
    type: "tool_search_call",
    execution: "client",
    arguments: argumentsObject,
  };
}

function customToolInput(
  value,
  allowPlaceholder = false,
  property = CUSTOM_TOOL_INPUT_PROPERTY,
) {
  if (allowPlaceholder && (value === undefined || value === "")) return "";
  const argumentsText = coerceFunctionCallArguments(value);
  if (typeof argumentsText !== "string") return undefined;
  if (!jsonArgumentsAreUnambiguous(argumentsText)) return undefined;
  try {
    const parsed = JSON.parse(argumentsText);
    return typeof parsed?.[property] === "string" ? parsed[property] : undefined;
  } catch {
    return undefined;
  }
}

const LITELLM_MAX_CUSTOM_ARGUMENTS_LENGTH = 1_000_000;

function litellmCustomToolInput(argumentsText) {
  if (typeof argumentsText !== "string") return undefined;
  if (argumentsText === "") return "";
  // Python counts Unicode code points, while JavaScript length counts UTF-16 units.
  if (argumentsText.length > LITELLM_MAX_CUSTOM_ARGUMENTS_LENGTH &&
      [...argumentsText].length > LITELLM_MAX_CUSTOM_ARGUMENTS_LENGTH) return argumentsText;
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
  if (!plainObject(parsed) || !Object.hasOwn(parsed, LITELLM_CUSTOM_TOOL_INPUT_PROPERTY)) {
    return argumentsText;
  }
  const content = parsed[LITELLM_CUSTOM_TOOL_INPUT_PROPERTY];
  return typeof content === "string" ? content : undefined;
}


function rewriteCustomToolFunctionCallItem(item, lookups, allowPlaceholder) {
  if (
    item?.type !== "function_call" ||
    item.namespace != null ||
    !(lookups.customTools instanceof Map)
  ) {
    return undefined;
  }
  const native = lookups.customTools.get(item.name);
  if (!native) return undefined;
  const input = customToolInput(item.arguments, allowPlaceholder);
  if (input === undefined) return undefined;
  const {
    type: _type,
    name: _name,
    namespace: _namespace,
    arguments: _arguments,
    encrypted_function_args: _encryptedFunctionArgs,
    ...rest
  } = item;
  return {
    ...rest,
    type: "custom_tool_call",
    ...native,
    ...(allowPlaceholder && input === "" ? {} : { input }),
  };
}

function rewriteNamespaceFunctionCallItem(
  item,
  lookups,
  sessionModel,
  { allowIncompleteToolSearch = false } = {},
) {
  if (!item || item.type !== "function_call") return undefined;
  if (!jsonArgumentsAreUnambiguous(item.arguments, { allowEmpty: true })) return undefined;
  const exactPlainProviderIdentity =
    lookups.identityAliases &&
    item.namespace === undefined &&
    lookups.plainToolNames?.has(item.name);
  const customTool = rewriteCustomToolFunctionCallItem(
    item,
    lookups,
    allowIncompleteToolSearch,
  );
  if (customTool) return customTool;
  const toolSearch = rewriteToolSearchFunctionCallItem(
    item,
    lookups,
    allowIncompleteToolSearch,
  );
  if (toolSearch) return toolSearch;
  let rewritten = item;
  const resolved = lookups.flatToNative.get(item.name);
  if (resolved) {
    const { namespace: _providerNamespace, ...rest } = item;
    rewritten = resolved.namespace === undefined
      ? { ...rest, name: resolved.name }
      : { ...rest, name: resolved.name, namespace: resolved.namespace };
  } else {
    const owners = lookups.bareToNamespaces.get(item.name);
    if (
      item.namespace === undefined &&
      !lookups.plainToolNames?.has(item.name) &&
      owners &&
      owners.size === 1
    ) {
      const [namespace] = [...owners];
      rewritten = {
        ...item,
        namespace,
      };
    }
  }
  rewritten = sanitizeSpawnAgentModel(rewritten, lookups);
  // A client may declare an ordinary function whose literal name is
  // `codex_app__create_thread`. Its request-local alias resolves back to that
  // exact plain identity, not the app namespace. Do not infer app semantics
  // from the restored spelling after the lookup has already proved otherwise.
  if (!exactPlainProviderIdentity) {
    rewritten = injectSessionModelForSpawnCalls(rewritten, sessionModel);
  }
  rewritten = rewriteFunctionCallArguments(rewritten);
  return rewritten === item ? undefined : rewritten;
}

export function rewriteNamespaceFunctionCall(event, lookups, sessionModel) {
  const item = rewriteNamespaceFunctionCallItem(event?.item, lookups, sessionModel, {
    allowIncompleteToolSearch: event?.type === "response.output_item.added",
  });
  return item ? { ...event, item } : undefined;
}

function rewriteOutputItems(output, lookups, sessionModel) {
  if (!Array.isArray(output)) return undefined;
  let changed = false;
  const rewritten = output.map((item) => {
    const next = rewriteNamespaceFunctionCallItem(item, lookups, sessionModel);
    if (!next) return item;
    changed = true;
    return next;
  });
  return changed ? rewritten : undefined;
}

function embeddedFunctionArgumentsAreUnambiguous(payload, rawCustomArguments = false) {
  const safeItem = (item) =>
    item?.type !== "function_call" ||
    jsonArgumentsAreUnambiguous(item.arguments, { allowEmpty: true });
  if (!safeItem(payload?.item)) return false;
  if (
    payload?.type === "response.function_call_arguments.done" &&
    !rawCustomArguments &&
    !jsonArgumentsAreUnambiguous(payload.arguments, { allowEmpty: true })
  ) {
    return false;
  }
  for (const output of [payload?.output, payload?.response?.output]) {
    if (!Array.isArray(output)) continue;
    if (!output.every(safeItem)) return false;
  }
  return true;
}

// Non-streaming Responses return completed function calls in an `output`
// array instead of SSE `item` events. Restore both shapes through the same
// exact request-local lookup so stream mode cannot change dispatch semantics.
// Returns a copy only when at least one call was restored.
export function rewriteNamespaceResponsePayload(payload, lookups, sessionModel) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  let rewritten = rewriteNamespaceFunctionCall(payload, lookups, sessionModel) || payload;
  let changed = rewritten !== payload;

  if (payload.type === "response.function_call_arguments.done") {
    const argumentsText = jsonArgumentsAreUnambiguous(rewritten.arguments, {
      allowEmpty: true,
    })
      ? coerceFunctionCallArguments(rewritten.arguments)
      : rewritten.arguments;
    if (argumentsText !== rewritten.arguments) {
      rewritten = { ...rewritten, arguments: argumentsText };
      changed = true;
    }
  }

  const output = rewriteOutputItems(rewritten.output, lookups, sessionModel);
  if (output) {
    rewritten = { ...rewritten, output };
    changed = true;
  }

  const responseOutput = rewriteOutputItems(rewritten.response?.output, lookups, sessionModel);
  if (responseOutput) {
    rewritten = {
      ...rewritten,
      response: { ...rewritten.response, output: responseOutput },
    };
    changed = true;
  }
  return changed ? rewritten : undefined;
}

const CUSTOM_TOOL_OPENING_LIMIT = 1024;
const LITELLM_CUSTOM_TOOL_INPUT_PROPERTY = "content";
const CUSTOM_TOOL_OPENING_PATTERNS = Object.freeze({
  [CUSTOM_TOOL_INPUT_PROPERTY]: /^\s*\{\s*"input"\s*:\s*"/,
  [LITELLM_CUSTOM_TOOL_INPUT_PROPERTY]: /^\s*\{\s*"content"\s*:\s*"/,
});
const JSON_ESCAPES = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

// Decode one new function-argument fragment into the native custom-tool input.
// The wrapper prefix is bounded and every encoded patch character is visited
// once. Only an incomplete escape (at most six characters) is retained between
// calls, avoiding the quadratic full-patch rescans that large streamed patches
// would otherwise trigger.
function customToolInputDelta(
  state,
  fragment,
  property = CUSTOM_TOOL_INPUT_PROPERTY,
) {
  if (typeof fragment !== "string" || state.invalid || state.closed) return undefined;
  let encoded = fragment;
  if (!state.opened) {
    state.opening += encoded;
    const openingPattern = CUSTOM_TOOL_OPENING_PATTERNS[property];
    if (!openingPattern) {
      state.opening = "";
      state.invalid = true;
      return undefined;
    }
    const opening = state.opening.match(openingPattern);
    if (!opening) {
      if (state.opening.length > CUSTOM_TOOL_OPENING_LIMIT) {
        state.opening = "";
        state.invalid = true;
      }
      return undefined;
    }
    state.opened = true;
    encoded = state.opening.slice(opening[0].length);
    state.opening = "";
  }

  if (state.escape) {
    encoded = state.escape + encoded;
    state.escape = "";
  }
  const decoded = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === '"') {
      state.closed = true;
      break;
    }
    if (character !== "\\") {
      if (character.charCodeAt(0) < 0x20) {
        state.invalid = true;
        break;
      }
      decoded.push(character);
      continue;
    }

    const escape = encoded[index + 1];
    if (escape === undefined) {
      state.escape = "\\";
      break;
    }
    if (escape === "u") {
      const digits = encoded.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]*$/.test(digits)) {
        state.invalid = true;
        break;
      }
      if (digits.length < 4) {
        state.escape = encoded.slice(index);
        break;
      }
      decoded.push(String.fromCharCode(Number.parseInt(digits, 16)));
      index += 5;
      continue;
    }
    if (!(escape in JSON_ESCAPES)) {
      state.invalid = true;
      break;
    }
    decoded.push(JSON_ESCAPES[escape]);
    index += 1;
  }
  return decoded.length ? decoded.join("") : undefined;
}

class NamespaceRelayCommittedStreamError extends Error {
  constructor(reason) {
    super(
      `The provider response became unsafe to relay after namespace output was committed (${reason}).`,
    );
    this.name = "NamespaceRelayCommittedStreamError";
    this.code = "ERR_NAMESPACE_RELAY_COMMITTED_STREAM";
    this.status = 502;
  }
}

// Rewrites LiteLLM's flattened `<namespace>__<tool>` function calls back to
// the namespace + name shape Codex dispatches through its app runtime.
export class NamespaceToolCallTransform extends Transform {
  #eventStream;
  #pendingParts = [];
  #pendingBytes = 0;
  #pendingTailBytes = 0;
  #released = false;
  #headerlessDetector;
  #sseParts = [];
  #sseBytes = 0;
  #sseTailBytes = 0;
  #sseNextPartBytes = INITIAL_SSE_CAPTURE_PART_BYTES;
  #sseLineBytes = 0;
  #ssePendingCr = false;
  #ssePendingLineWasBlank = false;
  #sseAtStreamStart = true;
  #sseLineEnding = "\n";
  #sseLineEndingObserved = false;
  #maxJsonCaptureBytes;
  #maxSseFrameBytes;
  #maxCommittedSseFrameBytes;
  #maxTrackedOutputItems;
  #maxTrackedStateBytes;
  #rewriteDisabled = false;
  #semanticMutationCommitted = false;
  #lookups;
  #sessionModel;
  // Every observed output-item identity reserves both ids. Special relays keep
  // their source and native shapes here until terminal validation so a stream
  // cannot change owners or fall back to raw function-call events after its
  // opening was rewritten.
  #callsByItemId = new Map();
  #callsByCallId = new Map();
  #trackedCallCount = 0;
  #trackedStateBytes = 0;

  constructor(namespaces, contentType = "", sessionModel, options = {}) {
    super();
    this.#lookups = buildNamespaceLookups(namespaces);
    this.#sessionModel = sessionModel;
    this.#maxJsonCaptureBytes =
      Number.isInteger(options.maxJsonCaptureBytes) && options.maxJsonCaptureBytes > 0
        ? options.maxJsonCaptureBytes
        : MAX_JSON_CAPTURE_BYTES;
    const configuredSseFrameBytes =
      Number.isInteger(options.maxSseFrameBytes) && options.maxSseFrameBytes > 0
        ? options.maxSseFrameBytes
        : undefined;
    this.#maxSseFrameBytes = configuredSseFrameBytes ?? MAX_SSE_FRAME_BYTES;
    this.#maxCommittedSseFrameBytes =
      Number.isInteger(options.maxCommittedSseFrameBytes) &&
      options.maxCommittedSseFrameBytes > 0
        ? options.maxCommittedSseFrameBytes
        : configuredSseFrameBytes ??
          Math.min(this.#maxJsonCaptureBytes, MAX_COMMITTED_SSE_FRAME_BYTES);
    this.#maxTrackedOutputItems =
      Number.isInteger(options.maxTrackedOutputItems) && options.maxTrackedOutputItems > 0
        ? options.maxTrackedOutputItems
        : MAX_TRACKED_OUTPUT_ITEMS;
    this.#maxTrackedStateBytes =
      Number.isInteger(options.maxTrackedStateBytes) && options.maxTrackedStateBytes > 0
        ? options.maxTrackedStateBytes
        : MAX_TRACKED_STATE_BYTES;
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#headerlessDetector =
      !this.#eventStream && !declared.includes("json")
        ? new HeaderlessSseDetector()
        : undefined;
  }

  _transform(chunk, _encoding, callback) {
    let error;
    try {
      if (this.#headerlessDetector) {
        const detected = this.#headerlessDetector.write(chunk);
        if (detected.decision !== "pending") {
          this.#headerlessDetector = undefined;
          this.#eventStream = detected.decision === "event-stream";
          for (const buffered of detected.chunks) this.#transformChunk(buffered);
        }
      } else {
        this.#transformChunk(chunk);
      }
    } catch (caught) {
      error = caught;
    }
    callback(error);
  }

  #transformChunk(chunk) {
    const bytes = Buffer.from(chunk);
    if (!this.#eventStream) {
      if (this.#released) {
        this.push(bytes);
        return;
      }
      this.#captureJsonBytes(bytes);
      return;
    }
    if (this.#rewriteDisabled) {
      this.push(bytes);
      return;
    }
    this.#consumeSseChunk(bytes);
  }

  _flush(callback) {
    let error;
    try {
      this.#flushTransform();
    } catch (caught) {
      error = caught;
    }
    callback(error);
  }

  #flushTransform() {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.end();
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
    }
    if (!this.#eventStream) {
      const body = this.#takeJsonCapture();
      if (this.#released || !body.length) {
        if (body.length) this.push(body);
        return;
      }
      if (!isUtf8(body)) {
        this.push(body);
        return;
      }
      const text = body.toString("utf8");
      if (!jsonIsUnambiguousForRewrite(text)) {
        this.push(body);
        return;
      }
      let original;
      try {
        original = JSON.parse(text);
      } catch {
        this.push(body);
        return;
      }
      if (!embeddedFunctionArgumentsAreUnambiguous(original)) {
        this.push(body);
        return;
      }
      const payload = rewriteNamespaceResponsePayload(
        original,
        this.#lookups,
        this.#sessionModel,
      ) || original;
      // Parsing is only permission to inspect. A response the transform did
      // not semantically change retains its exact original representation.
      if (payload !== original) this.#commitSemanticMutation();
      this.push(payload === original ? body : Buffer.from(JSON.stringify(payload), "utf8"));
      return;
    }
    if (this.#ssePendingCr && !this.#rewriteDisabled) {
      const blankLine = this.#ssePendingLineWasBlank;
      this.#ssePendingCr = false;
      this.#ssePendingLineWasBlank = false;
      this.#completeSseLine(blankLine);
    }
    if (!this.#rewriteDisabled && this.#sseBytes) {
      const tail = this.#takeSseFrame();
      this.#emitSseFrame(tail);
    }
    if (!this.#rewriteDisabled && this.#hasOpenSpecialCalls()) {
      if (this.#semanticMutationCommitted) {
        throw new NamespaceRelayCommittedStreamError("unterminated special tool call");
      }
      this.#disableSseRewriting();
    }
  }

  #captureJsonBytes(bytes) {
    // Fixed-size parts keep both copies and metadata bounded even when an
    // upstream fragments a body into one-byte chunks. Each byte is copied once
    // while capturing and at most once more for the final JSON parse.
    let offset = 0;
    while (offset < bytes.length && !this.#released) {
      let tail = this.#pendingParts.at(-1);
      if (!tail || this.#pendingTailBytes === tail.length) {
        const remainingUntilRelease =
          this.#maxJsonCaptureBytes + 1 - this.#pendingBytes;
        tail = Buffer.allocUnsafe(
          Math.min(CAPTURE_PART_BYTES, remainingUntilRelease),
        );
        this.#pendingParts.push(tail);
        this.#pendingTailBytes = 0;
      }
      const copied = Math.min(tail.length - this.#pendingTailBytes, bytes.length - offset);
      bytes.copy(
        tail,
        this.#pendingTailBytes,
        offset,
        offset + copied,
      );
      this.#pendingTailBytes += copied;
      this.#pendingBytes += copied;
      offset += copied;
      if (this.#pendingBytes > this.#maxJsonCaptureBytes) {
        for (let index = 0; index < this.#pendingParts.length; index += 1) {
          const part = this.#pendingParts[index];
          this.push(
            index === this.#pendingParts.length - 1
              ? part.subarray(0, this.#pendingTailBytes)
              : part,
          );
        }
        this.#pendingParts = [];
        this.#pendingBytes = 0;
        this.#pendingTailBytes = 0;
        this.#released = true;
      }
    }
    if (offset < bytes.length) this.push(bytes.subarray(offset));
  }

  #takeJsonCapture() {
    if (!this.#pendingParts.length) return Buffer.alloc(0);
    const lastIndex = this.#pendingParts.length - 1;
    const parts = this.#pendingParts.map((part, index) =>
      index === lastIndex ? part.subarray(0, this.#pendingTailBytes) : part,
    );
    const body =
      parts.length === 1 ? parts[0] : Buffer.concat(parts, this.#pendingBytes);
    this.#pendingParts = [];
    this.#pendingBytes = 0;
    this.#pendingTailBytes = 0;
    return body;
  }

  #consumeSseChunk(chunk) {
    let offset = 0;
    if (this.#ssePendingCr) {
      const followedByLf = chunk[0] === LINE_FEED;
      if (followedByLf) {
        if (!this.#appendSsePiece(chunk.subarray(0, 1))) {
          if (chunk.length > 1) this.push(chunk.subarray(1));
          return;
        }
        offset = 1;
      }
      const blankLine = this.#ssePendingLineWasBlank;
      this.#ssePendingCr = false;
      this.#ssePendingLineWasBlank = false;
      this.#completeSseLine(blankLine);
      if (this.#rewriteDisabled) {
        if (offset < chunk.length) this.push(chunk.subarray(offset));
        return;
      }
    }

    while (offset < chunk.length) {
      let lineEnd = offset;
      while (
        lineEnd < chunk.length &&
        chunk[lineEnd] !== CARRIAGE_RETURN &&
        chunk[lineEnd] !== LINE_FEED
      ) {
        lineEnd += 1;
      }

      if (lineEnd === chunk.length) {
        const content = chunk.subarray(offset);
        this.#sseLineBytes += content.length;
        this.#appendSsePiece(content);
        return;
      }
      if (lineEnd > offset) {
        const content = chunk.subarray(offset, lineEnd);
        this.#sseLineBytes += content.length;
        if (!this.#appendSsePiece(content)) {
          this.push(chunk.subarray(lineEnd));
          return;
        }
      }

      const blankLine = this.#sseLineBytes === 0;
      if (chunk[lineEnd] === CARRIAGE_RETURN) {
        if (!this.#appendSsePiece(chunk.subarray(lineEnd, lineEnd + 1))) {
          if (lineEnd + 1 < chunk.length) this.push(chunk.subarray(lineEnd + 1));
          return;
        }
        if (lineEnd + 1 === chunk.length) {
          this.#ssePendingCr = true;
          this.#ssePendingLineWasBlank = blankLine;
          this.#sseLineBytes = 0;
          return;
        }
        if (chunk[lineEnd + 1] === LINE_FEED) {
          if (!this.#appendSsePiece(chunk.subarray(lineEnd + 1, lineEnd + 2))) {
            if (lineEnd + 2 < chunk.length) this.push(chunk.subarray(lineEnd + 2));
            return;
          }
          offset = lineEnd + 2;
        } else {
          offset = lineEnd + 1;
        }
      } else {
        if (!this.#appendSsePiece(chunk.subarray(lineEnd, lineEnd + 1))) {
          if (lineEnd + 1 < chunk.length) this.push(chunk.subarray(lineEnd + 1));
          return;
        }
        offset = lineEnd + 1;
      }
      this.#completeSseLine(blankLine);
      if (this.#rewriteDisabled) {
        if (offset < chunk.length) this.push(chunk.subarray(offset));
        return;
      }
    }
  }

  #appendSsePiece(piece) {
    if (!piece.length) return true;
    // Copy into fixed-size parts exactly as the non-streaming capture does.
    // Retaining one view per upstream chunk would let a one-byte-fragmented
    // frame allocate millions of Buffer objects before reaching its byte cap.
    let offset = 0;
    const frameByteLimit = this.#semanticMutationCommitted
      ? this.#maxCommittedSseFrameBytes
      : this.#maxSseFrameBytes;
    while (offset < piece.length && this.#sseBytes <= frameByteLimit) {
      let tail = this.#sseParts.at(-1);
      if (!tail || this.#sseTailBytes === tail.length) {
        const remainingUntilRelease =
          frameByteLimit + 1 - this.#sseBytes;
        const remainingPieceBytes = piece.length - offset;
        const partBytes = Math.min(
          CAPTURE_PART_BYTES,
          Math.max(this.#sseNextPartBytes, Math.min(CAPTURE_PART_BYTES, remainingPieceBytes)),
          remainingUntilRelease,
        );
        tail = Buffer.allocUnsafe(partBytes);
        this.#sseParts.push(tail);
        this.#sseTailBytes = 0;
        this.#sseNextPartBytes = Math.min(CAPTURE_PART_BYTES, partBytes * 2);
      }
      const copied = Math.min(tail.length - this.#sseTailBytes, piece.length - offset);
      piece.copy(tail, this.#sseTailBytes, offset, offset + copied);
      this.#sseTailBytes += copied;
      this.#sseBytes += copied;
      offset += copied;
    }
    if (this.#sseBytes <= frameByteLimit) return true;
    const buffered = this.#takeSseFrame();
    if (this.#semanticMutationCommitted) {
      throw new NamespaceRelayCommittedStreamError("SSE frame byte limit");
    }
    this.#disableSseRewriting();
    this.push(buffered);
    if (offset < piece.length) this.push(piece.subarray(offset));
    return false;
  }

  #completeSseLine(blankLine) {
    this.#sseLineBytes = 0;
    if (blankLine) this.#emitSseFrame(this.#takeSseFrame());
  }

  #takeSseFrame() {
    if (!this.#sseParts.length) return Buffer.alloc(0);
    const lastIndex = this.#sseParts.length - 1;
    const parts = this.#sseParts.map((part, index) =>
      index === lastIndex ? part.subarray(0, this.#sseTailBytes) : part,
    );
    const frame = parts.length === 1 ? parts[0] : Buffer.concat(parts, this.#sseBytes);
    this.#sseParts = [];
    this.#sseBytes = 0;
    this.#sseTailBytes = 0;
    this.#sseNextPartBytes = INITIAL_SSE_CAPTURE_PART_BYTES;
    this.#sseLineBytes = 0;
    this.#ssePendingCr = false;
    this.#ssePendingLineWasBlank = false;
    return frame;
  }

  #sseFields(frame, atStreamStart) {
    let eventLine;
    let dataLine;
    let lineEndingLine;
    let repeated = false;
    let start = 0;
    let firstLine = true;
    while (start < frame.length) {
      let contentEnd = start;
      while (
        contentEnd < frame.length &&
        frame[contentEnd] !== CARRIAGE_RETURN &&
        frame[contentEnd] !== LINE_FEED
      ) {
        contentEnd += 1;
      }
      const end = contentEnd === frame.length
        ? frame.length
        : frame[contentEnd] === CARRIAGE_RETURN && frame[contentEnd + 1] === LINE_FEED
          ? contentEnd + 2
          : contentEnd + 1;
      let parseStart = start;
      if (
        firstLine &&
        atStreamStart &&
        frame.subarray(start, start + UTF8_BOM.length).equals(UTF8_BOM)
      ) {
        parseStart += UTF8_BOM.length;
      }
      firstLine = false;
      const line = { start, parseStart, contentEnd, end };
      if (!lineEndingLine && end > contentEnd) lineEndingLine = line;
      const lineLength = contentEnd - parseStart;
      const fieldLine = (name) =>
        lineLength >= name.length &&
        frame.subarray(parseStart, parseStart + name.length).equals(name) &&
        (lineLength === name.length || frame[parseStart + name.length] === 0x3a);
      if (fieldLine(SSE_EVENT_FIELD)) {
        if (eventLine) repeated = true;
        else eventLine = line;
      }
      if (fieldLine(SSE_DATA_FIELD)) {
        if (dataLine) repeated = true;
        else dataLine = line;
      }
      if (repeated || contentEnd === frame.length) break;
      start = end;
    }
    return { eventLine, dataLine, lineEndingLine, repeated };
  }

  #rememberSseLineEnding(frame, line) {
    if (this.#sseLineEndingObserved || !line || line.end === line.contentEnd) return;
    const terminator = frame.subarray(line.contentEnd, line.end);
    if (terminator.equals(Buffer.from("\r\n"))) this.#sseLineEnding = "\r\n";
    else if (terminator.equals(Buffer.from("\n"))) this.#sseLineEnding = "\n";
    else if (terminator.equals(Buffer.from("\r"))) this.#sseLineEnding = "\r";
    else return;
    this.#sseLineEndingObserved = true;
  }

  #emitSseFrame(frame) {
    for (const piece of this.#rewriteSseFrame(frame)) this.push(piece);
  }

  #commitSemanticMutation() {
    this.#semanticMutationCommitted = true;
  }

  #unsafeSseFrame(frame, reason) {
    if (this.#semanticMutationCommitted) {
      throw new NamespaceRelayCommittedStreamError(reason);
    }
    this.#disableSseRewriting();
    return [frame];
  }

  #disableSseRewriting() {
    this.#rewriteDisabled = true;
    this.#callsByItemId.clear();
    this.#callsByCallId.clear();
    this.#trackedCallCount = 0;
    this.#trackedStateBytes = 0;
  }

  #specialCallKind(item) {
    if (item?.type === "custom_tool_call") return "custom";
    if (item?.type === "tool_search_call") return "tool_search";
    return undefined;
  }

  #sourceSpecialCallKind(item) {
    const nativeKind = this.#specialCallKind(item);
    if (nativeKind) return nativeKind;
    if (item?.type !== "function_call") return undefined;
    if (this.#lookups.customTools instanceof Map && this.#lookups.customTools.has(item.name)) {
      return "custom";
    }
    if (item.name === this.#lookups.toolSearch?.providerName) return "tool_search";
    return undefined;
  }

  #hasOpenSpecialCalls() {
    for (const state of this.#callsByItemId.values()) {
      if (state.kind && !state.closed) return true;
    }
    return false;
  }

  #openingIdentityConflict(item) {
    const byItemId =
      typeof item?.id === "string" ? this.#callsByItemId.get(item.id) : undefined;
    const byCallId =
      typeof item?.call_id === "string"
        ? this.#callsByCallId.get(item.call_id)
        : undefined;
    if (byItemId || byCallId) return "duplicate output item identity";
    return undefined;
  }

  #storeCallState(state) {
    if (this.#trackedCallCount >= this.#maxTrackedOutputItems) {
      return "output item identity limit";
    }
    const retainedBytes = trackedStateBytes(state);
    if (retainedBytes > this.#maxTrackedStateBytes - this.#trackedStateBytes) {
      return "output item state byte limit";
    }
    if (state.itemId) this.#callsByItemId.set(state.itemId, state);
    if (state.callId) this.#callsByCallId.set(state.callId, state);
    this.#trackedCallCount += 1;
    this.#trackedStateBytes += retainedBytes;
    return undefined;
  }

  #registerCall(sourceItem, item) {
    const kind = this.#specialCallKind(item);
    const sourceKind = this.#sourceSpecialCallKind(sourceItem);
    if ((sourceKind || kind) && sourceKind !== kind) {
      return "special tool call opening was not restored consistently";
    }
    if (
      (kind === "custom" &&
        (typeof item.name !== "string" || !item.name ||
          (item.namespace != null && (typeof item.namespace !== "string" || !item.namespace)))) ||
      (kind === "tool_search" &&
        (item.name !== undefined ||
          item.namespace !== undefined ||
          item.execution !== "client" ||
          !plainObject(item.arguments)))
    ) {
      return "special tool call opening is incomplete";
    }
    const itemId = typeof item?.id === "string" && item.id ? item.id : undefined;
    const callId =
      typeof item?.call_id === "string" && item.call_id ? item.call_id : undefined;
    if (
      kind &&
      (!itemId ||
        !callId ||
        sourceItem?.id !== itemId ||
        sourceItem?.call_id !== callId)
    ) {
      return "special tool call opening lacks stable identity";
    }
    if (!itemId && !callId) return undefined;
    const conflict = this.#openingIdentityConflict(item);
    if (conflict) return conflict;
    const state = {
      kind,
      itemId,
      callId,
      sourceType: sourceItem?.type,
      sourceName: sourceItem?.name,
      sourceNamespace: sourceItem?.namespace,
      outputType: item.type,
      outputName: item.name,
      outputNamespace: item.namespace,
      argumentsDone: false,
      finalInputLength: undefined,
      finalInputDigest: undefined,
      finalArgumentsLength: undefined,
      finalArgumentsDigest: undefined,
      sawArgumentDelta: false,
      deltaCharacters: 0,
      deltaHash: kind === "custom" ? createHash("sha256") : undefined,
      closed: false,
      summarySeen: false,
      deltaState:
        kind === "custom"
          ? {
              opening: "",
              opened: false,
              escape: "",
              closed: false,
              invalid: false,
            }
          : undefined,
    };
    return this.#storeCallState(state);
  }

  // Some Responses bridges omit output_item.added and emit only one complete
  // done item or a terminal output summary. Treat that self-contained item as
  // a closed lifecycle, but reserve its identities exactly like a streamed
  // opening so later events cannot change owners or replay it.
  #registerAtomicSpecialCall(sourceItem, item, { summarySeen = false } = {}) {
    const sourceKind = this.#sourceSpecialCallKind(sourceItem);
    const kind = this.#specialCallKind(item);
    if (!sourceKind || sourceKind !== kind) {
      return "atomic special tool call was incomplete or restored inconsistently";
    }

    const callId = typeof item?.call_id === "string" && item.call_id
      ? item.call_id
      : undefined;
    if (!callId || sourceItem?.call_id !== callId) {
      return "atomic special tool call lacks stable identity";
    }
    const sourceHasItemId = Object.hasOwn(sourceItem, "id");
    const outputHasItemId = Object.hasOwn(item, "id");
    if (
      sourceHasItemId !== outputHasItemId ||
      (sourceHasItemId &&
        (typeof item.id !== "string" || !item.id || sourceItem.id !== item.id))
    ) {
      return "atomic special tool call lacks stable identity";
    }
    const itemId = outputHasItemId ? item.id : undefined;

    if (kind === "custom") {
      if (
        typeof item.name !== "string" ||
        !item.name ||
        (item.namespace != null && (typeof item.namespace !== "string" || !item.namespace)) ||
        typeof item.input !== "string"
      ) {
        return "incomplete atomic custom tool call";
      }
      if (sourceItem.type === "function_call") {
        const expected = this.#lookups.customTools?.get(sourceItem.name);
        if (
          expected?.name !== item.name || expected?.namespace !== item.namespace ||
          customToolInput(sourceItem.arguments) !== item.input
        ) {
          return "atomic custom tool call was not restored consistently";
        }
      } else if (
        sourceItem.name !== item.name ||
        sourceItem.namespace !== item.namespace ||
        sourceItem.input !== item.input
      ) {
        return "atomic custom tool call changed native content";
      }
    } else {
      if (
        item.name !== undefined ||
        item.namespace !== undefined ||
        item.execution !== "client" ||
        !plainObject(item.arguments)
      ) {
        return "incomplete atomic tool search call";
      }
      if (sourceItem.type === "function_call") {
        const sourceArguments = toolSearchArguments(sourceItem.arguments, false);
        if (
          sourceItem.name !== this.#lookups.toolSearch?.providerName ||
          !sourceArguments ||
          !isDeepStrictEqual(sourceArguments, item.arguments)
        ) {
          return "atomic tool search call was not restored consistently";
        }
      } else if (
        sourceItem.execution !== item.execution ||
        !isDeepStrictEqual(sourceItem.arguments, item.arguments)
      ) {
        return "atomic tool search call changed native content";
      }
    }

    const conflict = this.#openingIdentityConflict(item);
    if (conflict) return conflict;
    const finalInputFingerprint = kind === "custom"
      ? stringFingerprint(item.input)
      : undefined;
    const finalArgumentsFingerprint = kind === "tool_search"
      ? canonicalJsonFingerprint(item.arguments)
      : undefined;
    const state = {
      kind,
      itemId,
      callId,
      sourceType: sourceItem.type,
      sourceName: sourceItem.name,
      sourceNamespace: sourceItem.namespace,
      outputType: item.type,
      outputName: item.name,
      outputNamespace: item.namespace,
      argumentsDone: true,
      finalInputLength: finalInputFingerprint?.length,
      finalInputDigest: finalInputFingerprint?.digest,
      finalArgumentsLength: finalArgumentsFingerprint?.length,
      finalArgumentsDigest: finalArgumentsFingerprint?.digest,
      sawArgumentDelta: false,
      deltaCharacters: 0,
      deltaHash: undefined,
      closed: true,
      summarySeen,
      deltaState: undefined,
    };
    return this.#storeCallState(state);
  }

  #registerOrdinaryOutputItem(
    sourceItem,
    item,
    { closed = true, summarySeen = false } = {},
  ) {
    // Ordinary items reserve the same id domains as special relays. This also
    // covers nonterminal response snapshots, which can precede an explicit
    // output_item.done event and therefore must not be marked closed yet.
    const itemId = typeof item?.id === "string" && item.id ? item.id : undefined;
    const callId = typeof item?.call_id === "string" && item.call_id
      ? item.call_id
      : undefined;
    const sourceItemId = typeof sourceItem?.id === "string" && sourceItem.id
      ? sourceItem.id
      : undefined;
    const sourceCallId = typeof sourceItem?.call_id === "string" && sourceItem.call_id
      ? sourceItem.call_id
      : undefined;
    const sourceHasItemId = Boolean(
      sourceItem && typeof sourceItem === "object" && Object.hasOwn(sourceItem, "id"),
    );
    const outputHasItemId = Boolean(
      item && typeof item === "object" && Object.hasOwn(item, "id"),
    );
    const sourceHasCallId = Boolean(
      sourceItem && typeof sourceItem === "object" && Object.hasOwn(sourceItem, "call_id"),
    );
    const outputHasCallId = Boolean(
      item && typeof item === "object" && Object.hasOwn(item, "call_id"),
    );
    if (
      sourceItemId !== itemId ||
      sourceCallId !== callId ||
      sourceHasItemId !== outputHasItemId ||
      sourceHasCallId !== outputHasCallId ||
      (sourceHasItemId && !itemId) ||
      (sourceHasCallId && !callId)
    ) {
      return "output item lacks stable identity";
    }
    if (!itemId && !callId) return undefined;
    const conflict = this.#openingIdentityConflict(item);
    if (conflict) return conflict;
    const state = {
      kind: undefined,
      itemId,
      callId,
      sourceType: sourceItem?.type,
      sourceName: sourceItem?.name,
      sourceNamespace: sourceItem?.namespace,
      outputType: item?.type,
      outputName: item?.name,
      outputNamespace: item?.namespace,
      argumentsDone: true,
      finalInputLength: undefined,
      finalInputDigest: undefined,
      finalArgumentsLength: undefined,
      finalArgumentsDigest: undefined,
      sawArgumentDelta: false,
      deltaCharacters: 0,
      deltaHash: undefined,
      closed,
      summarySeen,
      deltaState: undefined,
    };
    return this.#storeCallState(state);
  }

  #registerAtomicOutputItem(sourceItem, item, { summarySeen = false } = {}) {
    const sourceKind = this.#sourceSpecialCallKind(sourceItem);
    const outputKind = this.#specialCallKind(item);
    if (sourceKind || outputKind) {
      return this.#registerAtomicSpecialCall(sourceItem, item, { summarySeen });
    }
    return this.#registerOrdinaryOutputItem(sourceItem, item, {
      closed: true,
      summarySeen,
    });
  }

  #outputItemMatchesState(sourceItem, item, state) {
    return (
      sourceItem?.id === state.itemId &&
      sourceItem?.call_id === state.callId &&
      sourceItem?.type === state.sourceType &&
      sourceItem?.name === state.sourceName &&
      sourceItem?.namespace === state.sourceNamespace &&
      item?.id === state.itemId &&
      item?.call_id === state.callId &&
      item?.type === state.outputType &&
      item?.name === state.outputName &&
      item?.namespace === state.outputNamespace
    );
  }

  #specialCallForArgumentsEvent(event) {
    const byItemId =
      typeof event?.item_id === "string"
        ? this.#callsByItemId.get(event.item_id)
        : undefined;
    const byCallId =
      typeof event?.call_id === "string"
        ? this.#callsByCallId.get(event.call_id)
        : undefined;
    if (byItemId && byCallId && byItemId !== byCallId) {
      return { reason: "conflicting special tool call identity" };
    }
    const state = byItemId || byCallId;
    if (!state || !state.kind) return {};
    if (event.item_id !== state.itemId) {
      return { reason: "mismatched special tool call item id" };
    }
    if (event.call_id !== undefined && event.call_id !== state.callId) {
      return { reason: "mismatched special tool call call id" };
    }
    if (state.closed) return { reason: "special tool call event after close" };
    return { state };
  }

  #customDeltaMismatch(state, inputFingerprint) {
    if (!state.sawArgumentDelta) return undefined;
    // If no decoded text reached Codex, the completed input cannot contradict it.
    if (state.sourceType === "custom_tool_call" && state.deltaCharacters === 0) return undefined;
    if (
      state.deltaState.invalid ||
      !state.deltaState.opened ||
      !state.deltaState.closed ||
      state.deltaState.escape
    ) {
      return "incomplete custom tool argument delta sequence";
    }
    if (state.deltaCharacters !== inputFingerprint.length) {
      return "custom tool argument deltas disagree with completed input";
    }
    const streamed = state.deltaHash.copy().digest();
    return streamed.equals(inputFingerprint.digest)
      ? undefined
      : "custom tool argument deltas disagree with completed input";
  }

  #closeOutputItem(sourceItem, item) {
    const byItemId =
      typeof sourceItem?.id === "string"
        ? this.#callsByItemId.get(sourceItem.id)
        : undefined;
    const byCallId =
      typeof sourceItem?.call_id === "string"
        ? this.#callsByCallId.get(sourceItem.call_id)
        : undefined;
    if (byItemId && byCallId && byItemId !== byCallId) {
      return "conflicting special tool call close identity";
    }
    const state = byItemId || byCallId;
    const sourceKind = this.#sourceSpecialCallKind(sourceItem);
    const outputKind = this.#specialCallKind(item);
    if (!state) {
      return this.#registerAtomicOutputItem(sourceItem, item);
    }
    if (state.closed) return "duplicate output item close";
    if (!this.#outputItemMatchesState(sourceItem, item, state)) {
      return state.kind || sourceKind || outputKind
        ? "mismatched special tool call close identity"
        : "mismatched output item close identity";
    }
    if (!state.kind) {
      state.closed = true;
      return undefined;
    }
    if (state.kind === "custom") {
      if (typeof item.input !== "string") {
        return "custom tool call input changed before close";
      }
      const inputFingerprint = stringFingerprint(item.input);
      if (
        state.argumentsDone &&
        !fingerprintMatches(
          inputFingerprint,
          state.finalInputLength,
          state.finalInputDigest,
        )
      ) {
        return "custom tool call input changed before close";
      }
      if (!state.argumentsDone) {
        const reason = this.#customDeltaMismatch(state, inputFingerprint);
        if (reason) return reason;
        state.finalInputLength = inputFingerprint.length;
        state.finalInputDigest = inputFingerprint.digest;
      }
      state.argumentsDone = true;
      state.deltaHash = undefined;
      state.deltaState = undefined;
    }
    if (state.kind === "tool_search") {
      const argumentsFingerprint = canonicalJsonFingerprint(item.arguments);
      if (
        state.argumentsDone &&
        !fingerprintMatches(
          argumentsFingerprint,
          state.finalArgumentsLength,
          state.finalArgumentsDigest,
        )
      ) {
        return "tool search arguments changed before close";
      }
      state.finalArgumentsLength = argumentsFingerprint.length;
      state.finalArgumentsDigest = argumentsFingerprint.digest;
      state.argumentsDone = true;
    }
    state.closed = true;
    return undefined;
  }

  #validateOutputSummaryItem(sourceItem, item, { allowAtomic = false } = {}) {
    const byItemId =
      typeof sourceItem?.id === "string"
        ? this.#callsByItemId.get(sourceItem.id)
        : undefined;
    const byCallId =
      typeof sourceItem?.call_id === "string"
        ? this.#callsByCallId.get(sourceItem.call_id)
        : undefined;
    if (byItemId && byCallId && byItemId !== byCallId) {
      return "conflicting special tool call summary identity";
    }
    const state = byItemId || byCallId;
    const sourceKind = this.#sourceSpecialCallKind(sourceItem);
    const outputKind = this.#specialCallKind(item);
    if (!state) {
      if (!allowAtomic) {
        if (sourceKind || outputKind) {
          return "special tool call summary without a matching opening";
        }
        return this.#registerOrdinaryOutputItem(sourceItem, item, {
          closed: false,
          summarySeen: false,
        });
      }
      return this.#registerAtomicOutputItem(sourceItem, item, { summarySeen: true });
    }
    if (!state.closed && state.kind) return "special tool call summary before close";
    if (state.summarySeen) return "duplicate output item summary";
    if (!this.#outputItemMatchesState(sourceItem, item, state)) {
      return state.kind || sourceKind || outputKind
        ? "mismatched special tool call summary identity"
        : "mismatched output item summary identity";
    }
    if (!state.kind) {
      // Progress snapshots may repeat the same ordinary item while its content
      // grows. They reserve and validate ownership, but only a terminal output
      // summary closes and consumes the one allowed summary transition.
      if (allowAtomic) {
        state.closed = true;
        state.summarySeen = true;
      }
      return undefined;
    }
    if (state.kind === "custom") {
      if (typeof item.input !== "string") {
        return "custom tool call summary input changed after close";
      }
      const inputFingerprint = stringFingerprint(item.input);
      if (
        !fingerprintMatches(
          inputFingerprint,
          state.finalInputLength,
          state.finalInputDigest,
        )
      ) {
        return "custom tool call summary input changed after close";
      }
    }
    if (state.kind === "tool_search") {
      const argumentsFingerprint = canonicalJsonFingerprint(item.arguments);
      if (
        !fingerprintMatches(
          argumentsFingerprint,
          state.finalArgumentsLength,
          state.finalArgumentsDigest,
        )
      ) {
        return "tool search arguments changed after close";
      }
    }
    if (allowAtomic) state.summarySeen = true;
    return undefined;
  }

  #validateOutputItems(sourceEvent, event, { allowAtomic = false } = {}) {
    for (const [sourceOutput, output] of [
      [sourceEvent?.output, event?.output],
      [sourceEvent?.response?.output, event?.response?.output],
    ]) {
      if (!Array.isArray(sourceOutput) || !Array.isArray(output)) continue;
      for (let index = 0; index < sourceOutput.length; index += 1) {
        const reason = this.#validateOutputSummaryItem(sourceOutput[index], output[index], {
          allowAtomic,
        });
        if (reason) return reason;
      }
    }
    return undefined;
  }

  #rewrittenSseFrame(frame, replacements) {
    const pieces = [];
    let cursor = 0;
    for (const [line, replacement] of [...replacements].sort(
      ([left], [right]) => left.start - right.start,
    )) {
      if (!line) continue;
      if (line.start > cursor) pieces.push(frame.subarray(cursor, line.start));
      if (line.parseStart > line.start) {
        pieces.push(frame.subarray(line.start, line.parseStart));
      }
      pieces.push(Buffer.from(replacement, "utf8"));
      cursor = line.contentEnd;
    }
    if (cursor < frame.length) pieces.push(frame.subarray(cursor));
    return Buffer.concat(pieces);
  }

  #rewriteSseFrame(frame) {
    const atStreamStart = this.#sseAtStreamStart;
    this.#sseAtStreamStart = false;
    // No decoder is allowed to see an undecided frame. Its replacement
    // character would make fail-open lossy before we knew whether to rewrite.
    if (!isUtf8(frame)) {
      return this.#unsafeSseFrame(frame, "invalid UTF-8");
    }
    const { eventLine, dataLine, lineEndingLine, repeated } = this.#sseFields(
      frame,
      atStreamStart,
    );
    this.#rememberSseLineEnding(frame, lineEndingLine);
    // SSE formally concatenates multiple data fields and gives repeated event
    // fields ordering semantics. Rewriting just one field would create bytes
    // whose EventSource meaning differs from the JSON we inspected. The
    // Responses wire uses exactly one of each, so anything else is preserved
    // and disables stateful rewriting for the remainder of this response.
    if (repeated) {
      return this.#unsafeSseFrame(frame, "repeated SSE event or data field");
    }
    const eventText = eventLine
      ? frame.subarray(eventLine.parseStart, eventLine.contentEnd).toString("utf8")
      : undefined;
    const eventName = eventText === undefined
      ? undefined
      : sseLineFieldValue(eventText, "event");
    const dataTextLine = dataLine
      ? frame.subarray(dataLine.parseStart, dataLine.contentEnd).toString("utf8")
      : undefined;
    const dataText = dataTextLine === undefined
      ? ""
      : sseLineFieldValue(dataTextLine, "data");
    if (!dataLine) return [frame];
    if (!dataText || dataText === "[DONE]") {
      if (eventName && eventName !== "message") {
        return this.#unsafeSseFrame(
          frame,
          "non-generic SSE event without a matching JSON type",
        );
      }
      // Inject before the stream terminator so Codex still executes the calls.
      if (dataText === "[DONE]") {
        if (this.#hasOpenSpecialCalls()) {
          return this.#unsafeSseFrame(frame, "stream ended before special tool call close");
        }
        return [frame];
      }
      return [frame];
    }
    if (!jsonIsUnambiguousForRewrite(dataText)) {
      return this.#unsafeSseFrame(frame, "ambiguous or malformed JSON event");
    }
    try {
      let event = JSON.parse(dataText);
      const payloadType = event?.type;
      const genericEventName = !eventName || eventName === "message";
      if (!genericEventName && payloadType !== eventName) {
        // The event field and JSON body are two claims about the same Responses
        // event. Do not choose whichever terminal/rewrite behavior is more
        // convenient when both claims are present and disagree.
        return this.#unsafeSseFrame(frame, "conflicting SSE event and JSON type");
      }
      const doneMatch = event?.type === "response.function_call_arguments.done"
        ? this.#specialCallForArgumentsEvent(event) : undefined;
      const rawCustomArguments = !doneMatch?.reason &&
        doneMatch?.state?.kind === "custom" &&
        doneMatch.state.sourceType === "custom_tool_call";
      if (!embeddedFunctionArgumentsAreUnambiguous(event, rawCustomArguments)) {
        return this.#unsafeSseFrame(frame, "ambiguous function arguments");
      }
      const sourceEvent = event;
      const originalEventType = event?.type;
      let changed = false;
      if (sourceEvent?.type === "response.output_item.added") {
        const conflict = this.#openingIdentityConflict(sourceEvent.item);
        if (conflict) return this.#unsafeSseFrame(frame, conflict);
      }
      if (
        (sourceEvent?.type === "response.custom_tool_call_input.delta" ||
          sourceEvent?.type === "response.custom_tool_call_input.done")
      ) {
        const matched = this.#specialCallForArgumentsEvent(sourceEvent);
        if (matched.reason) return this.#unsafeSseFrame(frame, matched.reason);
        if (matched.state?.sourceType === "function_call") {
          return this.#unsafeSseFrame(
            frame,
            "native custom input event inside a bridged function lifecycle",
          );
        }
      }
      if (
        event?.type === "response.function_call_arguments.delta"
      ) {
        const matched = this.#specialCallForArgumentsEvent(event);
        if (matched.reason) return this.#unsafeSseFrame(frame, matched.reason);
        if (matched.state) {
          if (matched.state.argumentsDone) {
            return this.#unsafeSseFrame(frame, "special tool call delta after arguments done");
          }
          if (matched.state.kind === "tool_search") {
            this.#commitSemanticMutation();
            return [];
          }
          matched.state.sawArgumentDelta = true;
          const argumentProperty =
            matched.state.sourceType === "custom_tool_call"
              ? LITELLM_CUSTOM_TOOL_INPUT_PROPERTY
              : CUSTOM_TOOL_INPUT_PROPERTY;
          const delta = customToolInputDelta(
            matched.state.deltaState,
            event.delta,
            argumentProperty,
          );
          if (delta === undefined) {
            this.#commitSemanticMutation();
            return [];
          }
          matched.state.deltaHash.update(Buffer.from(delta, "utf16le"));
          matched.state.deltaCharacters += delta.length;
          event = {
            ...event,
            type: "response.custom_tool_call_input.delta",
            delta,
          };
          changed = true;
        }
      }
      if (
        event?.type === "response.function_call_arguments.done"
      ) {
        const matched = this.#specialCallForArgumentsEvent(event);
        if (matched.reason) return this.#unsafeSseFrame(frame, matched.reason);
        if (matched.state) {
          if (matched.state.argumentsDone) {
            return this.#unsafeSseFrame(frame, "duplicate special tool call arguments done");
          }
          if (matched.state.kind === "tool_search") {
            const argumentsObject = toolSearchArguments(event.arguments, false);
            if (!argumentsObject) {
              return this.#unsafeSseFrame(frame, "invalid tool search arguments done");
            }
            const argumentsFingerprint = canonicalJsonFingerprint(argumentsObject);
            matched.state.argumentsDone = true;
            matched.state.finalArgumentsLength = argumentsFingerprint.length;
            matched.state.finalArgumentsDigest = argumentsFingerprint.digest;
            this.#commitSemanticMutation();
            return [];
          }
          const argumentProperty =
            matched.state.sourceType === "custom_tool_call"
              ? LITELLM_CUSTOM_TOOL_INPUT_PROPERTY
              : CUSTOM_TOOL_INPUT_PROPERTY;
          const input = matched.state.sourceType === "custom_tool_call"
            ? litellmCustomToolInput(event.arguments)
            : customToolInput(event.arguments, false, argumentProperty);
          if (input === undefined) {
            return this.#unsafeSseFrame(frame, "invalid custom tool arguments done");
          }
          const inputFingerprint = stringFingerprint(input);
          const deltaReason = this.#customDeltaMismatch(
            matched.state,
            inputFingerprint,
          );
          if (deltaReason) return this.#unsafeSseFrame(frame, deltaReason);
          const { arguments: _arguments, ...rest } = event;
          event = {
            ...rest,
            type: "response.custom_tool_call_input.done",
            input,
          };
          matched.state.argumentsDone = true;
          matched.state.finalInputLength = inputFingerprint.length;
          matched.state.finalInputDigest = inputFingerprint.digest;
          matched.state.deltaHash = undefined;
          matched.state.deltaState = undefined;
          changed = true;
        }
      }
      const next = rewriteNamespaceResponsePayload(event, this.#lookups, this.#sessionModel);
      if (next) {
        event = next;
        changed = true;
      }
      if (sourceEvent?.type === "response.output_item.added") {
        const reason = this.#registerCall(sourceEvent.item, event.item);
        if (reason) return this.#unsafeSseFrame(frame, reason);
      }
      if (sourceEvent?.type === "response.output_item.done") {
        const reason = this.#closeOutputItem(sourceEvent.item, event.item);
        if (reason) return this.#unsafeSseFrame(frame, reason);
      }
      const terminalEvent =
        event?.type === "response.completed" ||
        event?.type === "response.done" ||
        eventName === "response.completed" ||
        eventName === "response.done";
      const summaryReason = this.#validateOutputItems(sourceEvent, event, {
        allowAtomic: terminalEvent,
      });
      if (summaryReason) return this.#unsafeSseFrame(frame, summaryReason);
      if (terminalEvent) {
        if (this.#hasOpenSpecialCalls()) {
          return this.#unsafeSseFrame(frame, "terminal event before special tool call close");
        }
      }
      const replacements = [];
      if (
        eventLine &&
        typeof event?.type === "string" &&
        event.type !== originalEventType
      ) {
        replacements.push([eventLine, `event: ${event.type}`]);
      }
      if (!changed) return [frame];
      this.#commitSemanticMutation();
      replacements.push([dataLine, `data: ${JSON.stringify(event)}`]);
      return [this.#rewrittenSseFrame(frame, replacements)];
    } catch (error) {
      if (error instanceof NamespaceRelayCommittedStreamError) throw error;
      return this.#unsafeSseFrame(frame, "event rewrite failure");
    }
  }
}
