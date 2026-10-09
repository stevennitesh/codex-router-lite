import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This allowlist only reduces repeat tests for documents and proof records.
// Unknown paths and unavailable event bases retain the full Node matrix.
export function verificationScope(paths) {
  if (!Array.isArray(paths) || !paths.length) return "full";
  return paths.every(file => typeof file === "string" &&
    !/[\\\u0000-\u001f\u007f]/u.test(file) &&
    !file.split("/").some(part => !part || part === "." || part === "..") && (
      ["README.md", "SECURITY.md", "NOTICE.md"].includes(file) ||
      /^docs\/.+\.md$/u.test(file) ||
      /^docs\/history\/.+\.json$/u.test(file) ||
      /^v2_agent\/(?:README\.md|_template\/proof\.(?:json|md)|[^/]+\/[^/]+\/proof\.(?:json|md))$/u.test(file)
    )) ? "evidence" : "full";
}

export function eventVerificationScope({ cwd, eventName, event, head }) {
  const full = reason => ({ scope: "full", reason });
  const base = eventName === "push" ? event?.before : eventName === "pull_request" ? event?.pull_request?.base?.sha : undefined;
  const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/iu.test(value) && !/^0+$/u.test(value);
  if (!revision(base) || !revision(head)) return full("missing or unsupported event revisions");
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    if (git(["rev-parse", "HEAD"]).trim().toLowerCase() !== head.toLowerCase()) return full("checkout does not match event head");
    if (git(["status", "--porcelain", "-z"])) return full("checkout contains uncommitted inputs");
    git(["merge-base", "--is-ancestor", base, head]);
    const paths = git(["diff", "--name-only", "--no-renames", "-z", base, head, "--"]).split("\0").filter(Boolean);
    return { scope: verificationScope(paths), reason: `${paths.length} changed paths compared with the event base` };
  } catch {
    return full("event base or changed inputs unavailable");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let result;
  try {
    result = eventVerificationScope({ cwd: process.cwd(), eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), head: process.env.GITHUB_SHA });
  } catch { result = { scope: "full", reason: "event payload unavailable" }; }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `scope=${result.scope}\n`);
  console.log(JSON.stringify(result));
}
