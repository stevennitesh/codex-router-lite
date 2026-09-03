// Temporary adapter for litellm-config.mjs. Remove after issue #5 replaces the
// broad model registry with the retained GLM and Switchyard registry.
export { MODELS, providerForModel } from "../../model-registry.mjs";
