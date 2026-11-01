// Lightweight durable envelope contracts shared by serving and the immutable
// Stop adapter. Readable history and witness acquisition remain runtime owners.
export function validNativeCompactionReference(value) {
  const record = value !== null && typeof value === "object" && !Array.isArray(value);
  const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  return record && Object.keys(value).sort().join() === "checkpointSha256,opaqueSha256,sourceSha256,witnessSha256"
    && [value.checkpointSha256, value.opaqueSha256, value.sourceSha256, value.witnessSha256].every(sha256);
}

export function validNativeCompactionProjection(value, validReference) {
  return Array.isArray(value) && value.length > 0 && value.length <= 64
    && value.every(validReference) && new Set(value.map(item => item.opaqueSha256)).size === value.length;
}

export function validWebConversationGuard(value, normalUrl, validProjection) {
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(value)) return false;
  if (value.version !== 4) return [1, 2, 3].includes(value.version)
    && [value.priorVersion, value.pendingBrowserOpen, value.nativeCompactionProjection].every(field => field === undefined);
  if (![1, 2, 3].includes(value.priorVersion)
      || value.pendingBrowserOpen === undefined && value.nativeCompactionProjection === undefined) return false;
  const pending = value.pendingBrowserOpen;
  if (pending !== undefined && (!record(pending) || Object.keys(pending).sort().join() !== "callId,chatUrl,turnId"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(pending.turnId ?? "")
      || typeof pending.callId !== "string" || !/^call_router_web_[a-f0-9]{32}$/u.test(pending.callId)
      || !normalUrl(pending.chatUrl) || value.uncertainSend || value.lastTurn?.sendState !== "unsent"
      || value.lastTurn.completed !== false)) return false;
  return value.nativeCompactionProjection === undefined || validProjection(value.nativeCompactionProjection);
}

export function webConversationHistory(value) {
  return value?.version === 4 ? { ...value, version: value.priorVersion,
    priorVersion: undefined, pendingBrowserOpen: undefined, nativeCompactionProjection: undefined } : value;
}
