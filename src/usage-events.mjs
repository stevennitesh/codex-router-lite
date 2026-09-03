// The reduced router does not persist provider usage or billing events.
// Callers retain this observation hook only to avoid coupling request handling
// to an analytics sink.
export function recordUsageEvent() {}

export function toolResultAgingTotals() {
  return {
    aged: 0,
    bytesSaved: 0,
    retained: 0,
    retainedBytes: 0,
  };
}

export function recentUsageEvents() {
  return [];
}

export function allUsageEvents() {
  return [];
}

export function observedInputCeilings() {
  return {};
}
