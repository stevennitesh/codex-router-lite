const instant = { low: { power: 0, description: "Instant" } };
const thinking = {
  medium: { power: 1, description: "Medium" },
  high: { power: 2, description: "High" },
  xhigh: { power: 3, description: "Extra High", requires: ["extraHighAvailable"] },
};
const pro = { max: { power: 4, description: "Pro" } };

// A route's picker metadata and exact browser selection share this authority.
// Account observations restrict these routes; they never select a fallback.
export const WEB_MODEL_REGISTRY = [
  { slug: "chatgpt-web/gpt-6-sol-instant", displayName: "GPT-6 Sol Instant (Web)", family: "GPT-6", defaultEffort: "low", efforts: instant, requires: ["solAvailable"], contextProfile: "instant" },
  { slug: "chatgpt-web/gpt-6-sol", displayName: "GPT-6 Sol (Web)", family: "GPT-6", defaultEffort: "medium", efforts: thinking, requires: ["solAvailable"], contextProfile: "thinking" },
  { slug: "chatgpt-web/gpt-5.6-sol-instant", displayName: "GPT-5.6 Sol Instant (Web)", family: "GPT-5.6 Sol", defaultEffort: "low", efforts: instant, requires: ["solAvailable"], contextProfile: "instant" },
  { slug: "chatgpt-web/gpt-5.6-sol", displayName: "GPT-5.6 Sol (Web)", family: "GPT-5.6 Sol", defaultEffort: "medium", efforts: thinking, requires: ["solAvailable"], contextProfile: "thinking" },
  { slug: "chatgpt-web/gpt-5.6-pro", displayName: "GPT-5.6 Sol Pro (Web)", family: "GPT-5.6 Sol", defaultEffort: "max", efforts: pro, requires: ["solAvailable", "proAvailable"], contextProfile: "pro" },
  { slug: "chatgpt-web/gpt-6-pro", displayName: "GPT-6 Astra Pro (Web)", family: "GPT-6", defaultEffort: "max", efforts: pro, requires: ["solAvailable", "proAvailable"], contextProfile: "pro" },
];

export const WEB_ACCOUNT_CAPABILITY_KEYS = Object.freeze([...new Set(WEB_MODEL_REGISTRY.flatMap(row => [
  ...row.requires, ...Object.values(row.efforts).flatMap(level => level.requires ?? []),
]))]);

const contextProfiles = {
  instant: { standard: [41_000, 32_000], pro: [111_193, 95_000] },
  thinking: { standard: [90_000, 80_000], pro: [111_193, 95_000] },
  pro: { pro: [112_193, 95_000] },
};

export function webModelSelection(slug, effort) {
  const model = WEB_MODEL_REGISTRY.find(row => row.slug === slug);
  const selectedEffort = effort ?? model?.defaultEffort;
  const selected = model && Object.hasOwn(model.efforts, selectedEffort) ? model.efforts[selectedEffort] : undefined;
  if (!selected) throw Object.assign(new Error("This exact Web model and effort have no verified in-app selector."), { code: "web_model_unverified", status: 400 });
  return { family: model.family, power: selected.power };
}

export function buildWebBridgeModels(capabilities) {
  if (!capabilities || !WEB_ACCOUNT_CAPABILITY_KEYS.every(key => typeof capabilities[key] === "boolean")) {
    throw new Error("Web bridge account capabilities are missing or invalid; reconfigure the in-app browser with observed account capabilities.");
  }
  return WEB_MODEL_REGISTRY.filter(row => row.requires.every(key => capabilities[key])).map(row => {
    const levels = Object.entries(row.efforts).filter(([, level]) => (level.requires ?? []).every(key => capabilities[key]))
      .map(([effort, level]) => ({ effort, description: level.description }));
    const [window, compact] = contextProfiles[row.contextProfile][capabilities.proAvailable ? "pro" : "standard"];
    return { slug: row.slug, provider: "chatgpt-web", displayName: row.displayName, display_name: row.displayName,
      description: `${row.displayName}. Full harness: local tools use the configured MCP connector. Account model availability is verified by the bridge before sending.`,
      supportsSubagents: true,
      defaultEffort: row.defaultEffort, default_reasoning_level: row.defaultEffort, reasoningLevels: levels, supported_reasoning_levels: levels,
      multiAgentVersion: "v1", multi_agent_version: "v1", visibility: "list", supported_in_api: true,
      context_window: window, max_context_window: window, effective_context_window_percent: 100,
      auto_compact_token_limit: compact, tool_mode: null, upgrade: null,
      additional_speed_tiers: [], service_tiers: [], default_service_tier: null };
  });
}
