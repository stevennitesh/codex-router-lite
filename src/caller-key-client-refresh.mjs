import { isManagedCodexBaseUrl } from "./caller-auth.mjs";
import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";

const BLOCKS = [
  ["# BEGIN codex-router-provider-managed", "# END codex-router-provider-managed"],
  ["# BEGIN codex-router-signed-provider-managed", "# END codex-router-signed-provider-managed"],
];

function managedScalar(document, assignment, nextBase, port) {
  const oldBase = tomlStringValue(document, assignment.tablePath, assignment.key[0]);
  if (!isManagedCodexBaseUrl(oldBase, port)) {
    throw new Error("Codex caller capability assignment is not a managed router URL.");
  }
  const line = document.lines[assignment.index];
  return line.slice(0, assignment.valueStart) + JSON.stringify(nextBase) + line.slice(assignment.valueEnd);
}

export function refreshCodexCallerCapabilityContents(contents, nextBase, { port } = {}) {
  if (!isManagedCodexBaseUrl(nextBase, port)) {
    throw new Error("Refusing an invalid Codex router URL.");
  }
  const document = scanTomlDocument(String(contents ?? ""));
  const roots = document.assignments.filter(assignment =>
    assignment.tablePath.length === 0 && assignment.key.length === 1 &&
    assignment.key[0] === "openai_base_url");
  if (roots.length !== 1) {
    throw new Error("Codex caller capability refresh requires exactly one managed openai_base_url.");
  }
  const selected = [roots[0]];
  const ranges = [];
  for (const [begin, end] of BLOCKS) {
    const starts = document.comments.filter(comment => comment.text === begin);
    const ends = document.comments.filter(comment => comment.text === end);
    if (!starts.length && !ends.length) continue;
    if (starts.length !== 1 || ends.length !== 1 || ends[0].index <= starts[0].index) {
      throw new Error(`Managed caller capability block ${begin} is ambiguous.`);
    }
    const from = starts[0].index, to = ends[0].index;
    if (ranges.some(([left, right]) => from < right && to > left)) {
      throw new Error("Managed caller capability blocks overlap.");
    }
    ranges.push([from, to]);
    const bases = document.assignments.filter(assignment =>
      assignment.index > from && assignment.index < to &&
      assignment.key.length === 1 && assignment.key[0] === "base_url");
    if (bases.length !== 1 || bases[0].tablePath.length !== 2 ||
        bases[0].tablePath[0] !== "model_providers") {
      throw new Error(`Managed caller capability block ${begin} has no unique provider base_url.`);
    }
    selected.push(bases[0]);
  }
  // Validate every edit before changing bytes. Keep key spelling, comments,
  // instruction examples and line endings intact.
  const edits = selected.map(assignment => [assignment.index,
    managedScalar(document, assignment, nextBase, port)]);
  for (const [index, line] of edits) document.lines[index] = line;
  return document.lines.join("\n");
}
