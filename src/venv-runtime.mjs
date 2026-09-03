// A LiteLLM virtual environment can retain its launcher while its interpreter
// is unusable. Probing the interpreter turns a bare spawn failure into a
// checkable, fixable state.
import { spawnSync } from "node:child_process";

// Returns undefined when the interpreter runs, or a human-readable reason it
// cannot. `spawn` is injectable so tests can stub it without forking.
export function venvRuntimeProblem(
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
      ? `timed out after ${retryTimeoutMs} ms; transient process scheduling pressure is possible and this is not proof of a broken virtual environment`
      : probe.error.message;
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || "").trim() || "no stderr";
    return `exited with code ${probe.status}: ${detail}`;
  }
  return undefined;
}
