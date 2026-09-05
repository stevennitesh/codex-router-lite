import { lstatSync } from "node:fs";

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
