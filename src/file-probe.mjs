import { lstatSync, readFileSync } from "node:fs";

export function fileProbeErrorReason(error) {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "access-denied";
  return "probe-failed";
}

export function probeRegularFile(target, { lstat = lstatSync } = {}) {
  try {
    const stat = lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: "invalid" };
    }
    return { status: "present" };
  } catch (error) {
    return {
      status: fileProbeErrorReason(error),
      ...(error?.code ? { code: error.code } : {}),
    };
  }
}

// Schema and absence policy belong to the caller. Never turn an existing
// unreadable or malformed document into the same state as first use.
export function readJsonFile(target, { probe = probeRegularFile, read = readFileSync } = {}) {
  const observed = probe(target);
  if (observed.status !== "present") return observed;
  let contents;
  try { contents = read(target, "utf8"); }
  catch (error) {
    // A file that disappears after the probe is not confirmed first-use absence.
    return { status: fileProbeErrorReason(error) === "missing" ? "probe-failed" : fileProbeErrorReason(error),
      ...(error?.code ? { code: error.code } : {}) };
  }
  try { return { status: "present", value: JSON.parse(contents) }; }
  catch { return { status: "invalid" }; }
}
