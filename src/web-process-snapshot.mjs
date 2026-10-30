// Bounded, content-free observations. These never authorize Stop or termination.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const PROCESS_SNAPSHOT_VERSION = 1;
export const PROCESS_ASSOCIATION_LIMIT = 32;
const REQUEST_LIMIT = 1024;
export const processImageDigest = value => typeof value === 'string' && value
  ? createHash('sha256').update(resolve(value).toLowerCase()).digest('hex') : null;
const request = message => message && message.method && Object.hasOwn(message, 'id');
const terminal = message => message && !message.method && Object.hasOwn(message, 'id');

export class WebProcessSnapshot {
  constructor({ pid = process.pid, parentPid = process.ppid, image = process.execPath, childImage } = {}) {
    Object.assign(this, { pid, parentPid, imageSha256: processImageDigest(image), childImageSha256: processImageDigest(childImage) });
    this.associations = new Map(); this.associationComplete = true;
    this.outer = new Map(); this.child = new Map(); this.requestsComplete = true;
  }
  observeIdentity(identity, required) {
    if (!identity) { if (required) this.associationComplete = false; return; }
    const key = `${identity.threadId}:${identity.sessionId}`;
    if (!this.associations.has(key) && this.associations.size >= PROCESS_ASSOCIATION_LIMIT) { this.associationComplete = false; return; }
    this.associations.set(key, { threadId: identity.threadId, sessionId: identity.sessionId,
      subagent: ['parent_thread_id', 'subagent_header', 'subagent_kind'].some(field => identity.canonical[field] != null) });
  }
  outerReceived(message) {
    if (request(message)) this.add(this.outer, message.id);
    if (message?.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      if (this.outer.has(id)) this.outer.set(id, true);
      if (this.child.has(id)) this.child.set(id, true);
    }
  }
  childSent(message) {
    if (request(message)) this.add(this.child, message.id);
    if (message?.method === 'notifications/cancelled' && this.child.has(message.params?.requestId)) this.child.set(message.params.requestId, true);
  }
  childReceived(message) { if (terminal(message)) this.child.delete(message.id); }
  outerSent(message) { if (terminal(message)) this.outer.delete(message.id); }
  add(target, id) {
    if (target.has(id) || target.size >= REQUEST_LIMIT) { this.requestsComplete = false; return; }
    target.set(id, false);
  }
  snapshot(bridge) {
    const countCancelled = entries => [...entries.values()].filter(Boolean).length;
    return { schemaVersion: PROCESS_SNAPSHOT_VERSION, pid: this.pid, parentPid: this.parentPid,
      imageSha256: this.imageSha256, officialChildPid: Number.isSafeInteger(bridge.child.pid) && bridge.child.pid > 0 ? bridge.child.pid : null,
      childImageSha256: this.childImageSha256, associations: [...this.associations.values()], associationComplete: this.associationComplete,
      requestsComplete: this.requestsComplete, outerInflight: this.outer.size, childInflight: this.child.size,
      outerCancelledAwaitingTerminal: countCancelled(this.outer), childCancelledAwaitingTerminal: countCancelled(this.child),
      webAuthorityRetained: Boolean(bridge.cache || bridge.currentAuthority), cleanupActive: Boolean(bridge.cleanupGroup),
      hookPending: bridge.hooks.size > 0 || bridge.builtinTerminals.size > 0,
      observationWaiting: [...bridge.pending.values()].some(value => Boolean(value.wait)),
      closed: bridge.closed };
  }
}
