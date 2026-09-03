/**
 * Shape native Codex catalog entries for compatibility assertions without
 * freezing the installed catalog schema.
 */
export function nativeClientModels(nativeCatalogModels) {
  return (nativeCatalogModels || [])
    .filter((model) => model?.slug && model.visibility !== "hide")
    .map((model) => ({
      slug: String(model.slug),
      displayName: model.display_name ? `${model.display_name} (Codex)` : String(model.slug),
      contextWindow: Number.isFinite(model.context_window) ? model.context_window : undefined,
      inputModalities: Array.isArray(model.input_modalities) ? model.input_modalities : ["text"],
      reasoningLevels: Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .filter((level) => level?.effort)
            .map((level) => ({ effort: level.effort }))
        : [],
      ...(typeof model.default_reasoning_level === "string"
        ? { defaultEffort: model.default_reasoning_level }
        : {}),
      priority: Number.isFinite(model.priority) ? -model.priority : undefined,
      native: true,
    }));
}
