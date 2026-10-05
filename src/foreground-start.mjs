import { withServiceOperationLock } from "./service-operation-lock.mjs";
import { markForegroundSupervisor } from "./service-process.mjs";

// The foreground launcher owns the lifecycle lock, but is not the managed
// start.mjs payload identified by the Windows service-process record.
markForegroundSupervisor();

try {
  // Importing start.mjs does not resolve until its top-level supervisor finishes,
  // so lifecycle ownership covers preflight, child startup, serving, and drain.
  await withServiceOperationLock(() => import("./start.mjs"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
