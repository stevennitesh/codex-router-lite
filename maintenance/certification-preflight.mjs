// Read-only preparation for a native certification window. Never grants acceptance.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKED_IN_MODELS, MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { CODEX_AGENTS_DIR, MERGED_CATALOG_PATH, INSTALL_MANIFEST_PATH } from "../src/paths.mjs";

const PROOF_TEMPLATE = JSON.parse(readFileSync(new URL("../v2_agent/_template/proof.json", import.meta.url), "utf8"));
const USAGE = "Usage: node maintenance/certification-preflight.mjs <exact-route-slug> [<exact-route-slug> ...] | --all";
const FIRST_MARKER = "CERT_FIRST_OK", SECOND_MARKER = "CERT_SECOND_OK";

function readOptional(file) {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function draftProofFor(route, deployedCommit) {
  const proof = { ...structuredClone(PROOF_TEMPLATE), provider: route.provider,
    model: route.upstreamModel, slug: route.slug, routerCommit: deployedCommit || "" };
  if (route.provider === "openrouter") {
    proof.endpointProvider = route.openRouterProviderPolicy.only[0];
    proof.officialSources = [`https://openrouter.ai/api/v1/models/${route.upstreamModel}/endpoints`];
    delete proof.runtimeBinding;
  } else {
    delete proof.endpointProvider;
  }
  return proof;
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
    firstMarker: FIRST_MARKER, secondMarker: SECOND_MARKER,
    deployedCommit, readyForFreshParent: blockers.length === 0, blockers,
    application: `v2_agent/${route.slug}/`,
    draftProof: draftProofFor(route, deployedCommit),
    parentPrompt: `Run one synthetic native collaboration certification. Spawn exactly one ${role.agentName} child with no inherited conversation if available. Assign it: use the native exec_command tool with cmd "Write-Output (19+23)" and default sandbox permissions, then return ${FIRST_MARKER}. If the tool is offered only through functions.exec, use exactly text(await tools.exec_command({"cmd":"Write-Output (19+23)","sandbox_permissions":"use_default"})); with no other work in that wrapper. Do not read project files or browse. Wait for completion, then ask that same child to return ${SECOND_MARKER} without tools. Wait for completion and clean up the finished child. Report the actual outcome. If the role is unavailable, stop; do not substitute another role or model.`,
    evidenceRequired: ["Successful streamed provider completion", "Actual successful native tool output", "Two encrypted handoffs in one child rollout", "Both markers in that child", "Successful Router timings for that exact route and window"],
  };
}

// Resolve before reading local state: a typo must not produce a partial plan.
export function certificationRoutes(args) {
  if (args.length === 1 && args[0] === "--all") return [...CHECKED_IN_MODELS];
  if (!args.length || args.some(arg => arg.startsWith("--"))) throw new Error(USAGE);
  if (new Set(args).size !== args.length) throw new Error("Each exact route may be requested only once.");
  return args.map(slug => {
    const route = MODEL_BY_SLUG.get(slug);
    if (!route) throw new Error(`Unknown exact route: ${slug}. ${USAGE}`);
    return route;
  });
}

// One shared state snapshot, with each generated role read once. Missing files
// mean not ready; access errors remain errors rather than missing configuration.
export function certificationBatchPreflight(routes, {
  catalogPath = MERGED_CATALOG_PATH,
  manifestPath = INSTALL_MANIFEST_PATH,
  agentsDir = CODEX_AGENTS_DIR,
  read = readOptional,
} = {}) {
  const catalog = JSON.parse(read(catalogPath) || "{}");
  const manifest = JSON.parse(read(manifestPath) || "{}");
  const entries = new Map((catalog.models || []).map(model => [model.slug, model]));
  const reports = routes.map(route => certificationPreflight(route, {
    catalogEntry: entries.get(route.slug),
    roleContents: read(path.join(agentsDir, routedAgentDefinition(route).fileName)),
    deployedCommit: manifest.current?.commit,
  }));
  return {
    readyForFreshParent: reports.length > 0 && reports.every(report => report.readyForFreshParent), reports,
    runManifestTemplate: {
      version:1,startedAt:"",endedAt:"",parentSessionId:"",
      routerCommit:manifest.current?.commit || "",sourceRoot:manifest.current?.sourceRoot || "",
      codexVersion:"",windowsAppVersion:"",executionSurface:"",windowsSandbox:"",
      sandboxPolicy:"workspace-write",approvalPolicy:"on-request",
      routes:reports.map(({slug,firstMarker,secondMarker}) => ({slug,firstMarker,secondMarker})),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const routes = certificationRoutes(process.argv.slice(2));
    const batch = certificationBatchPreflight(routes);
    // Preserve the original single-route interface for existing callers.
    const report = process.argv.length === 3 && process.argv[2] !== "--all"
      ? {...batch.reports[0],runManifestTemplate:batch.runManifestTemplate} : batch;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.readyForFreshParent ? 0 : 1;
  } catch (error) {
    console.error(error.code ? `Certification state could not be read (${error.code}). Retry with the state owner's authority.` : error.message);
    process.exitCode = 1;
  }
}
