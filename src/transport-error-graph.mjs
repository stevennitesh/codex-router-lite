// Error causes and AggregateError members share a representation, while callers
// retain their own diagnosis, conclusive-refusal and retry policies.
export function transportErrorGraph(error) {
  const nodes = [], leaves = [], visited = new Set();
  const pending = [{value:error,depth:0}], active = new Set();
  let complete = true;
  while (pending.length) {
    const {value,depth,exit} = pending.pop();
    if (exit) { active.delete(value); continue; }
    if (!value || typeof value !== "object") { complete = false; continue; }
    if (active.has(value)) { complete = false; continue; }
    if (visited.has(value)) continue;
    if (nodes.length >= 256) { complete = false; break; }
    visited.add(value); nodes.push(value);
    const children = [];
    if (value.cause != null) children.push(value.cause);
    if (Array.isArray(value.errors)) {
      if (value.errors.length > 256) complete = false;
      children.push(...value.errors.slice(0,256));
    }
    if (!children.length) leaves.push(value);
    else if (depth >= 8) complete = false;
    else {
      active.add(value);
      pending.push({value,exit:true});
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({value:children[index],depth:depth+1});
      }
    }
  }
  return {nodes,leaves,complete};
}

// The same negative liveness proof protects credential publication and service
// replacement. An unknown branch, truncated graph or cycle proves nothing.
export function conclusivelyRefused(error) {
  const graph = transportErrorGraph(error);
  const codes = graph.nodes.map(node => node.code).filter(code => typeof code === "string" && code);
  return graph.complete && graph.leaves.length > 0 &&
    graph.leaves.every(node => node.code === "ECONNREFUSED") &&
    !graph.nodes.some(node => node.status || ["AbortError", "TimeoutError"].includes(node.name)) &&
    codes.length > 0 && codes.every(code => code === "ECONNREFUSED");
}
