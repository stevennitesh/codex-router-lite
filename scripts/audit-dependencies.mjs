import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Invoke the npm CLI belonging to this npm run, without a PowerShell/cmd shim.
export async function auditDependencies({ npmCli = process.env.npm_execpath, run = spawnSync, sleep = setTimeout, log = console.log } = {}) {
  if (!npmCli) throw new Error("Run through npm run audit:ci so npm_execpath identifies the active npm CLI");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run(process.execPath, [npmCli, "audit", "--omit=dev", "--audit-level=high", "--json"], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { /* Unknown output fails closed. */ }
    const counts = payload?.metadata?.vulnerabilities;
    const report = counts && ["high", "critical"].every((key) => Number.isInteger(counts[key]) && counts[key] >= 0);
    // Findings win even if stderr also describes a network problem.
    if (report && (counts.high > 0 || counts.critical > 0)) {
      log(result.stdout);
      return 1;
    }
    if (!result.error && result.status === 0 && report && !payload.error) {
      log(result.stdout);
      return 0;
    }
    const code = payload?.error?.code ?? result.error?.code;
    const transient = /^(?:E5\d\d|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH)$/u.test(String(code));
    if (!transient || attempt === 3) {
      log(result.stdout || result.stderr || result.error?.message || "npm audit returned no valid report");
      return 1;
    }
    log(`npm audit infrastructure failure (${code}); retry ${attempt + 1}/3`);
    await sleep(5_000 * attempt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await auditDependencies();
}
