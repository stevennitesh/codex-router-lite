// Read-only preparation for a native certification window. Never grants acceptance.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { CODEX_AGENTS_DIR, MERGED_CATALOG_PATH, INSTALL_MANIFEST_PATH } from "../src/paths.mjs";

function readOptional(file) {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export function certificationPreflight(route, { catalogEntry, roleContents, deployedCommit } = {}) {
  if (!route) throw new Error("An exact registered route is required.");
  const role = routedAgentDefinition(route);
  const blockers = [];
  if (route.multiAgentVersion !== "v2") blockers.push("Source route is v1: create a draft application and set multiAgentVersion to v2 only for the authorized proof window.");
  if (catalogEntry?.visibility !== "list") blockers.push(`Route is hidden or absent: node src/control.mjs picker show ${route.slug}`);
  if (catalogEntry?.multi_agent_version !== "v2") blockers.push("Published catalog is not v2: node src/refresh-catalog.mjs after checking picker and subagent selection.");
  if (roleContents?.replaceAll("\r\n", "\n") !== role.contents.replaceAll("\r\n", "\n")) blockers.push("Native role is missing or stale: refresh the catalog and check local subagent selection.");
  if (!/^[a-f0-9]{40}$/i.test(deployedCommit || "")) blockers.push("No deployed Router commit was found; verify installation before collecting proof.");
  return {
    slug: route.slug, role: role.agentName, effort: route.defaultEffort,
    deployedCommit, readyForFreshParent: blockers.length === 0, blockers,
    application: `v2_agent/${route.slug}/`,
    parentPrompt: `Run one synthetic native collaboration certification. Spawn exactly one ${role.agentName} child with no inherited conversation if available. Assign it: use a native tool to compute 19+23 (PowerShell Write-Output (19+23) for a shell) and return CERT_FIRST_OK. Do not read project files or browse. Wait for completion, then ask that same child to return CERT_SECOND_OK without tools. Wait for completion and clean up the finished child. Report the actual outcome. If the role is unavailable, stop; do not substitute another role or model.`,
    evidenceRequired: ["Successful streamed provider completion", "Actual successful native tool output", "Two encrypted handoffs in one child rollout", "Both markers in that child", "Successful Router timings for that exact route and window"],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const route = MODEL_BY_SLUG.get(process.argv[2]);
    if (!route) throw new Error("Usage: node maintenance/certification-preflight.mjs <exact-route-slug>");
    const catalog = JSON.parse(readOptional(MERGED_CATALOG_PATH) || "{}");
    const manifest = JSON.parse(readOptional(INSTALL_MANIFEST_PATH) || "{}");
    const role = routedAgentDefinition(route);
    const report = certificationPreflight(route, {
      catalogEntry: catalog.models?.find(model => model.slug === route.slug),
      roleContents: readOptional(path.join(CODEX_AGENTS_DIR, role.fileName)),
      deployedCommit: manifest.current?.commit,
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.readyForFreshParent ? 0 : 1;
  } catch (error) {
    console.error(error.code ? `Certification state could not be read (${error.code}). Retry with the state owner's authority.` : error.message);
    process.exitCode = 1;
  }
}
