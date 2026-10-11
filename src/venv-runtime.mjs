// A LiteLLM virtual environment can retain its launcher while its interpreter
// is unusable. Probing the interpreter turns a bare spawn failure into a
// checkable, fixable state.
import { spawnSync } from "node:child_process";

// A timeout is inconclusive; a spawn error or bad exit proves a failed probe.
// Startup can proceed to actual readiness without repeating this probe.
export function venvRuntimeOutcome(
  python,
  { spawn = spawnSync, timeoutMs = 15_000, retryTimeoutMs = 45_000 } = {},
) {
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };

  // A spawnSync timeout means Windows never finished scheduling the child; it
  // is not evidence that the interpreter or its venv is damaged. Retry once
  // with a wider hard bound before reporting a condition that can be transient
  // under process-launch contention.
  // `--version` is handled before CPython initializes its standard library,
  // so it can succeed even when the venv cannot import `encodings` and every
  // real invocation fails. Isolated mode also keeps an operator's PYTHONHOME
  // or PYTHONPATH from making a healthy managed environment look damaged.
  const probeArgs = ["-I", "-c", "import encodings, sys; print(sys.prefix)"];
  let probe = spawn(python, probeArgs, { ...options, timeout: timeoutMs });
  if (probe.error?.code === "ETIMEDOUT") {
    probe = spawn(python, probeArgs, { ...options, timeout: retryTimeoutMs });
  }
  if (probe.error) {
    return probe.error.code === "ETIMEDOUT"
      ? { kind: "timeout", message: `timed out after ${retryTimeoutMs} ms; transient process scheduling pressure is possible and this is not proof of a broken virtual environment` }
      : { kind: "failed", message: probe.error.message };
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || "").trim() || "no stderr";
    return { kind: "failed", message: `exited with code ${probe.status}: ${detail}` };
  }
  return { kind: "ok" };
}

// Doctor and install-plan retain their descriptive string API.
export function venvRuntimeProblem(python, options) {
  return venvRuntimeOutcome(python, options).message;
}

export function requireGatewayRuntime(python, { probe = venvRuntimeOutcome, warn = console.warn, dependencyFix } = {}) {
  const outcome = probe(python);
  if (outcome.kind === "failed") {
    throw new Error(`The LiteLLM virtual environment is broken at ${python} (${outcome.message}). ${dependencyFix}.`);
  }
  if (outcome.kind === "timeout") {
    warn(`[codex-router] LiteLLM interpreter probe ${outcome.message}; continuing to bounded gateway readiness.`);
  }
}
