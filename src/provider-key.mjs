import { unlinkSync } from "node:fs";
import {
  apiProvider,
  credentialStatus,
  primaryCredentialPath,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { disableProvider, enableProvider } from "./provider-selection.mjs";
import { promptForSecret } from "./secret-prompt.mjs";

export {
  powerShellStartupError,
  WINDOWS_HIDDEN_PROMPT_SCRIPT,
  windowsHiddenPromptArgs,
} from "./secret-prompt.mjs";

const providerId = process.argv[2];
const command = process.argv[3] || "status";

if (providerId !== "openrouter" || !new Set(["status", "set", "remove"]).has(command)) {
  console.error("Usage: provider-key.mjs openrouter status|set|remove");
  process.exitCode = 2;
} else {
  const provider = apiProvider("openrouter");
  if (command === "status") {
    const status = credentialStatus(provider);
    process.stdout.write(status.configured
      ? `OpenRouter API key is configured via ${status.source}.\n`
      : "OpenRouter API key is not configured.\n");
    if (!status.configured) process.exitCode = 1;
  } else if (command === "set") {
    const value = promptForSecret("OpenRouter API key");
    const target = writeProviderCredential(provider, value);
    enableProvider("openrouter");
    process.stdout.write(`OpenRouter API key saved to protected local storage at ${target}.\n`);
  } else {
    const target = primaryCredentialPath(provider);
    let removed = false;
    try {
      unlinkSync(target);
      removed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    disableProvider("openrouter");
    process.stdout.write(removed ? "Removed the managed OpenRouter API key.\n" : "No managed OpenRouter API key exists.\n");
  }
}
