import { randomBytes } from "node:crypto";

import { secretEqual } from "./caller-auth.mjs";

export const SWITCHYARD_CALLBACK_LEASE_HEADER =
  "x-codex-router-switchyard-callback-lease";

const MAX_WORKFLOWS = 256;
const MAX_CALLS_PER_WORKFLOW = 128;

function drainError() {
  const error = new Error("The local router is draining for a service operation.");
  error.status = 503;
  error.code = "ERR_ROUTER_DRAINING";
  return error;
}

export class RouterAdmission {
  #state = "open";
  #active = new Map();
  #callbackLeases = new Map();
  #workflows = new Map();
  #indeterminateWorkflow = false;
  #peers = new Set();
  #pendingDrain;

  begin({ controller, nestedCallbackLease } = {}) {
    const nestedOwner = nestedCallbackLease
      ? this.#callbackLeases.get(nestedCallbackLease)
      : undefined;
    if (this.#state !== "open" && !nestedOwner) throw drainError();
    const token = {};
    this.#active.set(token, { controller, nestedOwner });
    return {
      token,
      finish: () => this.finish(token),
      issueSwitchyardCallbackLease: () => this.issueSwitchyardCallbackLease(token),
    };
  }

  finish(token) {
    if (!this.#active.delete(token)) return;
    for (const [lease, owner] of this.#callbackLeases) {
      if (owner === token) this.#callbackLeases.delete(lease);
    }
    this.#settleDrainIfReady();
  }

  issueSwitchyardCallbackLease(owner) {
    if (!this.#active.has(owner)) {
      throw new Error("Cannot issue a Switchyard callback lease for an inactive request.");
    }
    const lease = randomBytes(32).toString("hex");
    this.#callbackLeases.set(lease, owner);
    return lease;
  }

  consumeSwitchyardCallbackLease(headers = {}) {
    const raw = headers[SWITCHYARD_CALLBACK_LEASE_HEADER];
    delete headers[SWITCHYARD_CALLBACK_LEASE_HEADER];
    if (typeof raw !== "string") return undefined;
    for (const lease of this.#callbackLeases.keys()) {
      if (secretEqual(raw, lease)) return lease;
    }
    return undefined;
  }

  registerPeer(peer) {
    this.#peers.add(peer);
    return () => this.#peers.delete(peer);
  }

  admitWebSocketMessage() {
    if (this.#state !== "open") throw drainError();
  }

  recordSwitchyardWorkflow({ identity, consumed = [], produced = [], complete = true } = {}) {
    const validConsumed = consumed.filter((value) => typeof value === "string" && value);
    const validProduced = produced.filter((value) => typeof value === "string" && value);
    if (!complete || ((validConsumed.length || validProduced.length) && !identity)) {
      this.#indeterminateWorkflow = true;
      this.#deferPendingDrain("switchyard-workflow-indeterminate");
      return;
    }
    if (!identity) return;
    let calls = this.#workflows.get(identity);
    if (calls) {
      for (const call of validConsumed) calls.delete(call);
    }
    if (validProduced.length) {
      if (!calls) {
        if (this.#workflows.size >= MAX_WORKFLOWS) {
          this.#indeterminateWorkflow = true;
          this.#deferPendingDrain("switchyard-workflow-capacity");
          return;
        }
        calls = new Set();
        this.#workflows.set(identity, calls);
      }
      for (const call of validProduced) {
        if (calls.size >= MAX_CALLS_PER_WORKFLOW && !calls.has(call)) {
          this.#indeterminateWorkflow = true;
          this.#deferPendingDrain("switchyard-workflow-capacity");
          return;
        }
        calls.add(call);
      }
    }
    if (calls?.size === 0) this.#workflows.delete(identity);
    if (validProduced.length) this.#deferPendingDrain("switchyard-workflow-active");
  }

  status() {
    let workflowCalls = 0;
    for (const calls of this.#workflows.values()) workflowCalls += calls.size;
    return {
      capability: "drain-v1",
      state: this.#state,
      activeRequests: this.#active.size,
      websocketPeers: this.#peers.size,
      workflows: this.#workflows.size,
      workflowCalls,
      indeterminateWorkflow: this.#indeterminateWorkflow,
    };
  }

  async drain({ timeoutMs = 30_000, force = false } = {}) {
    if (force) {
      this.#state = "closed";
      this.#finishPendingDrain({ status: "forced", ...this.status() });
      for (const { controller } of this.#active.values()) {
        controller?.abort?.(drainError());
      }
      for (const peer of this.#peers) peer.forceClose?.();
      this.#workflows.clear();
      this.#indeterminateWorkflow = false;
      return { status: "forced", ...this.status() };
    }
    if (this.#pendingDrain) return this.#pendingDrain.promise;
    if (this.#indeterminateWorkflow || this.#workflows.size) {
      return { status: "deferred", reason: "switchyard-workflow-active", ...this.status() };
    }
    this.#state = "draining";
    if (this.#active.size === 0) {
      this.#state = "closed";
      return { status: "drained", ...this.status() };
    }
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    const timer = setTimeout(() => {
      this.#state = "open";
      this.#finishPendingDrain({
        status: "deferred",
        reason: "timeout",
        ...this.status(),
      });
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    this.#pendingDrain = { promise, resolve, timer };
    return promise;
  }

  resume() {
    this.#state = "open";
    this.#finishPendingDrain({ status: "resumed", ...this.status() });
    return { status: "resumed", ...this.status() };
  }

  #settleDrainIfReady() {
    if (this.#state !== "draining" || this.#active.size || this.#hasWorkflow()) return;
    this.#state = "closed";
    this.#finishPendingDrain({ status: "drained", ...this.status() });
  }

  #hasWorkflow() {
    return this.#indeterminateWorkflow || this.#workflows.size > 0;
  }

  #deferPendingDrain(reason) {
    if (this.#state !== "draining") return;
    this.#state = "open";
    this.#finishPendingDrain({ status: "deferred", reason, ...this.status() });
  }

  #finishPendingDrain(result) {
    const pending = this.#pendingDrain;
    if (!pending) return;
    this.#pendingDrain = undefined;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
}

export function switchyardWorkflowIdentity(headers = {}, clientMetadata) {
  const direct = [headers["session-id"], headers.session_id, headers["x-session-id"]]
    .filter((value) => typeof value === "string" && value);
  if (direct.length && new Set(direct).size === 1) return `session:${direct[0]}`;
  const values = [headers["x-codex-turn-metadata"], clientMetadata?.["x-codex-turn-metadata"]];
  for (const value of values) {
    if (typeof value !== "string" || value.length > 8 * 1024) continue;
    try {
      const parsed = JSON.parse(value);
      const identity = parsed?.session_id || parsed?.thread_id;
      if (typeof identity === "string" && identity) return `turn:${identity}`;
    } catch {
      // Invalid optional metadata cannot become workflow authority.
    }
  }
  return undefined;
}

const CLIENT_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "computer_call",
  "local_shell_call",
  "shell_call",
  "apply_patch_call",
  "tool_search_call",
]);
const CLIENT_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "computer_call_output",
  "local_shell_call_output",
  "shell_call_output",
  "apply_patch_call_output",
  "tool_search_output",
]);

function callIdentity(item) {
  return typeof item?.call_id === "string" && item.call_id
    ? item.call_id
    : typeof item?.id === "string" && item.id
      ? item.id
      : undefined;
}

export function clientToolCalls(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => CLIENT_CALL_TYPES.has(item?.type))
    .map(callIdentity)
    .filter(Boolean);
}

export function clientToolOutputs(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => CLIENT_OUTPUT_TYPES.has(item?.type))
    .map(callIdentity)
    .filter(Boolean);
}
