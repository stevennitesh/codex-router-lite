// Read-only preparation for a native certification window. Never grants acceptance.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKED_IN_MODELS, MODEL_BY_SLUG } from "../src/routed-models.mjs";
import { routedAgentDefinition } from "../src/codex-agent-catalog.mjs";
import { CODEX_AGENTS_DIR, MERGED_CATALOG_PATH, INSTALL_MANIFEST_PATH } from "../src/paths.mjs";

const PROOF_TEMPLATE = JSON.parse(readFileSync(new URL("../v2_agent/_template/proof.json", import.meta.url), "utf8"));
const USAGE = "Usage: node maintenance/certification-preflight.mjs <exact-route-slug> [<exact-route-slug> ...] | --all | --renewal switchyard/auto";
const FIRST_MARKER = "CERT_FIRST_OK", SECOND_MARKER = "CERT_SECOND_OK";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Unknown/shared changes need diff review, not automatic live model requests.
// This assessment cannot accept evidence or grant permission for live work.
export function switchyardRenewalScope(paths, { comparisonAvailable = true } = {}) {
  const changes = { unrelated: [], switchyard: [], review: [] };
  for (const input of paths) {
    const file = String(input).replaceAll("\\", "/");
    if (/^(?:docs|test|v2_agent|\.github|LICENSES)\//u.test(file) ||
        /^(?:README\.md|AGENTS\.md|SECURITY\.md|LICENSE|NOTICE\.md)$/u.test(file) ||
        /^config\/openrouter\//u.test(file) ||
        /^config\/switchyard\/.*\.md$/u.test(file)) {
      changes.unrelated.push(file);
    } else if (/^config\/switchyard\/(?:source\.lock|routes\.template\.toml|auto\.json|switchyard\.json|patches\/.*\.patch)$/u.test(file)) {
      changes.switchyard.push(file);
    } else {
      changes.review.push(file);
    }
  }
  const decision = !comparisonAvailable ? "review" : changes.switchyard.length ? "renew" : changes.review.length ? "review" : "retain";
  return {
    slug: "switchyard/auto", decision, changes,
    reasons: [!comparisonAvailable
      ? "The tested revision cannot be compared with this candidate; inspect the source before deciding."
      : decision === "renew"
        ? "Switchyard's pinned implementation or policy changed; renew its exact-route proof after deployment."
        : decision === "review"
          ? "Review shared or unknown changes for Switchyard request, tool, handoff, continuation, instruction or execution behavior. Renew only if that contract changed."
          : "These source changes do not alter Switchyard behavior. Retain the accepted proof after ordinary source and deployment checks."],
    limits: ["Source assessment only: a changed installed binary, effective routing policy, or Codex execution/tool contract still needs an explicit renewal decision.",
      "A Router commit change or elapsed time alone does not require renewal. Historical proof identities must not be rewritten.",
      "This command neither accepts evidence nor authorizes or runs model requests."],
  };
}

export function switchyardRenewalAssessment({ repoRoot = ROOT, read = readFileSync } = {}) {
  const proof = JSON.parse(read(path.join(repoRoot, "v2_agent/switchyard/auto/proof.json"), "utf8"));
  const testedCommit = proof.routerCommit;
  if (proof.status !== "accepted" || proof.slug !== "switchyard/auto" ||
      typeof testedCommit !== "string" ||
      !/^[a-f0-9]{40}$/iu.test(testedCommit || "") ||
      typeof proof.runtimeBinding?.routerCommit !== "string" ||
      proof.runtimeBinding.routerCommit.toLowerCase() !== testedCommit.toLowerCase()) {
    return {...switchyardRenewalScope([], { comparisonAvailable: false }), testedCommit: null};
  }
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  try {
    const candidateCommit = git("rev-parse", "--verify", "HEAD").trim();
    git("merge-base", "--is-ancestor", testedCommit, candidateCommit);
    // Include staged and unstaged edits. Keep old paths on renames so a shared
    // module renamed into docs cannot disappear from the review scope.
    const paths = [...new Set([
      ...git("diff", "--no-renames", "--name-only", "-z", testedCommit, "--").split("\0"),
      ...git("diff", "--cached", "--no-renames", "--name-only", "-z", testedCommit, "--").split("\0"),
      ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
    ].filter(Boolean))].sort();
    return {...switchyardRenewalScope(paths), testedCommit, candidateCommit};
  } catch {
    return {...switchyardRenewalScope([], { comparisonAvailable: false }), testedCommit};
  }
}

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
    if (process.argv.length === 4 && process.argv[2] === "--renewal" && process.argv[3] === "switchyard/auto") {
      console.log(JSON.stringify(switchyardRenewalAssessment(), null, 2));
      // These are valid assessments. Inspect decision; no outcome starts work.
      process.exitCode = 0;
    } else {
      const routes = certificationRoutes(process.argv.slice(2));
      const batch = certificationBatchPreflight(routes);
      // Preserve the original single-route interface for existing callers.
      const report = process.argv.length === 3 && process.argv[2] !== "--all"
        ? {...batch.reports[0],runManifestTemplate:batch.runManifestTemplate} : batch;
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.readyForFreshParent ? 0 : 1;
    }
  } catch (error) {
    console.error(error.code ? `Certification state could not be read (${error.code}). Retry with the state owner's authority.` : error.message);
    process.exitCode = 1;
  }
}
