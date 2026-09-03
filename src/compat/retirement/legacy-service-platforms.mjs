// Temporary adapter for service.mjs. Remove after issues #4 and #5 retire the
// excluded non-Windows service platforms and managed Ollama lifecycle.
const serviceScripts = {
  darwin: "service-macos.mjs",
  linux: "service-linux.mjs",
};

export function legacyServiceScriptForPlatform(platform) {
  return serviceScripts[platform];
}

export async function stopLegacyManagedOllama() {
  const { stopManagedOllama } = await import("../../ollama-runtime.mjs");
  return stopManagedOllama();
}
