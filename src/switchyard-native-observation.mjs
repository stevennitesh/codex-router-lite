import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { secretEqual } from "./caller-auth.mjs";
import { STATE_DIR } from "./paths.mjs";
import { SWITCHYARD_OBSERVATION_HEADER } from "./switchyard-runtime.mjs";

const KNOWN_MODELS = new Set(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"]);
const KNOWN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const KNOWN_TIERS = new Set(["default", "priority", "flex"]);
const IDENTITY_HEADERS = ["session-id", "session_id", "x-session-id"];
const MAX_ASSOCIATIONS = 128;

function configuredLogPath(env = process.env) {
  if (env.CODEX_ROUTER_SWITCHYARD_ATTEMPT_OBSERVATION !== "1") return undefined;
  if (env.CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG) {
    return path.resolve(env.CODEX_ROUTER_SWITCHYARD_ATTEMPT_LOG);
  }
  const codexHome = env.CODEX_HOME || path.dirname(STATE_DIR);
  const runtimeRoot = env.CODEX_ROUTER_SWITCHYARD_ROOT || path.join(codexHome, "switchyard");
  return path.join(runtimeRoot, "native-attempts.jsonl");
}

function safeIdentity(value) {
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : undefined;
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
      /^[A-Za-z0-9._:-]+$/u.test(value)
    ? value
    : undefined;
}

export function explicitConversationIdentity(headers = {}) {
  const present = IDENTITY_HEADERS.filter((name) => Object.hasOwn(headers, name));
  if (!present.length) return undefined;
  const values = present.map((name) => safeIdentity(headers[name]));
  if (values.some((value) => value === undefined)) return undefined;
  if (!values.length || new Set(values).size !== 1) return undefined;
  return values[0];
}

function safeEnum(value, known) {
  return typeof value === "string" && known.has(value) ? value : "unknown";
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function observationMetadata(metadata = {}) {
  const usage = metadata.usage && typeof metadata.usage === "object"
    ? Object.fromEntries([
      ["inputTokens", safeCounter(metadata.usage.inputTokens)],
      ["cachedInputTokens", safeCounter(metadata.usage.cachedInputTokens)],
      ["cacheWriteTokens", safeCounter(metadata.usage.cacheWriteTokens)],
      ["outputTokens", safeCounter(metadata.usage.outputTokens)],
    ].filter(([, value]) => value !== undefined))
    : {};
  const returnedModel = safeEnum(metadata.returnedModel, KNOWN_MODELS);
  const returnedTier = safeEnum(metadata.returnedTier, KNOWN_TIERS);
  return {
    ...(Number.isInteger(metadata.httpStatus) && metadata.httpStatus >= 0 && metadata.httpStatus <= 599
      ? { httpStatus: metadata.httpStatus }
      : {}),
    outcome: safeEnum(metadata.outcome, new Set([
      "completed", "incomplete", "cancelled", "http_error", "stream_error",
      "transport_error", "empty_completion", "retryable_http", "unknown",
    ])),
    ...(returnedModel !== "unknown" ? { returnedModel } : {}),
    ...(returnedTier !== "unknown" ? { returnedTier } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
  };
}

export class SwitchyardNativeAttemptObserver {
  #path;
  #capability;
  #append;
  #associations = new Map();
  #nextAssociation = 1;

  constructor({
    env = process.env,
    capability = env.CODEX_ROUTER_SWITCHYARD_CAPABILITY,
    append = appendFileSync,
  } = {}) {
    this.#path = configuredLogPath(env);
    this.#append = append;
    this.#capability = typeof capability === "string" && capability
      ? createHash("sha256").update(capability, "utf8").digest("hex")
      : undefined;
    if (this.#path && this.#capability) this.#write({ event: "generation_start" });
  }

  enabled() {
    return Boolean(this.#path && this.#capability);
  }

  consumeAttribution(headers = {}) {
    const supplied = headers[SWITCHYARD_OBSERVATION_HEADER];
    delete headers[SWITCHYARD_OBSERVATION_HEADER];
    return this.enabled() && typeof supplied === "string" &&
      secretEqual(supplied, this.#capability);
  }

  beginRequest(headers, requestMetadata) {
    if (!this.enabled()) return undefined;
    const identity = explicitConversationIdentity(headers);
    let association;
    let ordered = false;
    if (identity) {
      association = this.#associations.get(identity);
      if (!association) {
        if (this.#associations.size >= MAX_ASSOCIATIONS) {
          const idle = [...this.#associations.entries()].find(([, value]) => value.active.size === 0);
          if (idle) this.#associations.delete(idle[0]);
        }
        if (this.#associations.size < MAX_ASSOCIATIONS) {
          association = {
            ordinal: this.#nextAssociation,
            requestOrdinal: 0,
            active: new Set(),
          };
          this.#nextAssociation += 1;
          this.#associations.set(identity, association);
        }
      }
    }
    const context = {
      association,
      ordered: Boolean(association),
      requestOrdinal: association ? ++association.requestOrdinal : undefined,
      nextAttempt: 0,
      current: undefined,
      metadata: {
        model: safeEnum(requestMetadata?.model, KNOWN_MODELS),
        effort: safeEnum(requestMetadata?.effort, KNOWN_EFFORTS),
        requestedTier: safeEnum(requestMetadata?.requestedTier, KNOWN_TIERS),
        compactionItems: safeEnum(
          requestMetadata?.compactionItems,
          new Set(["present", "absent", "unknown"]),
        ),
      },
    };
    if (association) {
      if (association.active.size) {
        for (const active of association.active) active.ordered = false;
        context.ordered = false;
        this.#write({ event: "association_reset", association: association.ordinal, reason: "overlap" });
      }
      association.active.add(context);
    }
    return context;
  }

  beginAttempt(context, now = Date.now()) {
    if (!context) return;
    if (context.current) this.finishAttempt(context, { outcome: "unknown" }, now);
    context.current = { ordinal: ++context.nextAttempt, startedAt: now };
  }

  finishAttempt(context, metadata = {}, now = Date.now()) {
    if (!context?.current) return;
    const current = context.current;
    context.current = undefined;
    this.#write({
      event: "native_attempt",
      association: context.ordered ? context.association?.ordinal ?? null : null,
      request: context.ordered ? context.requestOrdinal ?? null : null,
      attempt: current.ordinal,
      ...context.metadata,
      elapsedMs: Math.max(0, Math.round(now - current.startedAt)),
      ...observationMetadata(metadata),
    });
  }

  endRequest(context) {
    if (!context) return;
    if (context.current) this.finishAttempt(context, { outcome: "unknown" });
    context.association?.active.delete(context);
  }

  #write(record) {
    if (!this.#path) return;
    try {
      this.#append(this.#path, `${JSON.stringify({ schemaVersion: 1, ...record })}\n`, {
        encoding: "utf8",
        flag: "a",
      });
    } catch {
      // Opt-in diagnostics never alter request transport or outcome.
      this.#path = undefined;
      this.#associations.clear();
    }
  }
}

export function nativeAttemptLogPath(env = process.env) {
  return configuredLogPath(env);
}
