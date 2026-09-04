import { execFileSync } from "node:child_process";

import { secretEntryFeedback, secretEntryProblem } from "./secret-entry.mjs";

const WINDOWS_HIDDEN_PROMPT_SCRIPT = [
  "$secret = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL -AsSecureString",
  "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
].join("; ");

// A -Command argument is re-parsed by Windows before PowerShell sees it, so
// carry the script as base64 UTF-16LE. Keep try/finally in one array element:
// joining between them would produce `}; finally`, which PowerShell rejects.
function windowsHiddenPromptArgs(script = WINDOWS_HIDDEN_PROMPT_SCRIPT) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

const WINDOWS_POWERSHELL_CANDIDATES = ["powershell.exe", "pwsh.exe"];

function powerShellStartupError(failures) {
  return failures.find((error) => error?.code !== "ENOENT") ||
    new Error(
      "PowerShell is required for hidden API-key input, but neither powershell.exe nor pwsh.exe could be started.",
    );
}

function hiddenPrompt(label) {
  const args = windowsHiddenPromptArgs();
  const failures = [];
  for (const executable of WINDOWS_POWERSHELL_CANDIDATES) {
    try {
      return execFileSync(executable, args, {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: label },
        stdio: ["inherit", "pipe", "inherit"],
      });
    } catch (error) {
      failures.push(error);
    }
  }
  throw powerShellStartupError(failures);
}

function visiblePrompt(label) {
  const script = "[Console]::Out.Write((Read-Host $env:CODEX_ROUTER_PROMPT_LABEL))";
  let lastError;
  for (const executable of WINDOWS_POWERSHELL_CANDIDATES) {
    try {
      return execFileSync(executable, ["-NoLogo", "-NoProfile", "-Command", script], {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: label },
        stdio: ["inherit", "pipe", "inherit"],
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("PowerShell is required for interactive confirmation.");
}

const MAX_KEY_ATTEMPTS = 3;

export function promptForSecret(label) {
  // Echo stays disabled while the value is entered. Report only its length,
  // and challenge input that resembles the same key pasted twice.
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt += 1) {
    const value = hiddenPrompt(label);
    process.stdout.write(`${secretEntryFeedback(value)}\n`);
    const problem = secretEntryProblem(value);
    if (!problem) return value;
    let reason;
    if (problem === "empty") {
      reason = "No key was captured.";
    } else {
      const answer = visiblePrompt(
        "The input looks like the same key pasted twice. Save it anyway? [y/N]",
      ).trim();
      if (/^y(es)?$/i.test(answer)) return value;
      reason = "Discarded the doubled input.";
    }
    if (attempt === MAX_KEY_ATTEMPTS) {
      throw new Error(`${reason} Nothing was saved.`);
    }
    process.stdout.write(`${reason} Paste or type the key again.\n`);
  }
  throw new Error("Nothing was saved.");
}
