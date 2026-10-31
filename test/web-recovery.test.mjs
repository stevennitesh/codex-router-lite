import assert from "node:assert/strict";
import test from "node:test";
import { assertControlledRecoveryOffline } from "../maintenance/web-recovery.mjs";

const refused = () => Promise.reject(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
const offline = () => ({ inspect: () => ({ adapter: {} }), absent: () => {},
  taskState: async () => ({ instanceCount: 0, launcherAlive: false, enabled: false }),
  fetchImpl: refused, readProcess: () => undefined, stopped: state => assert.equal(state, undefined) });

test("controlled recovery requires disabled task, native census, recorded exit and conclusively absent listener without draining", async () => {
  const calls = [], dependencies = offline();
  dependencies.absent = () => calls.push("census");
  dependencies.fetchImpl = (url, options) => {
    assert.ok(url.endsWith("/live"));
    assert.equal(options.method, undefined, "Offline proof issues only a read, never a lifecycle mutation.");
    return refused();
  };
  await assertControlledRecoveryOffline(dependencies);
  assert.deepEqual(calls, ["census", "census"]);
  for (const changed of [
    { taskState: async () => undefined },
    { taskState: async () => ({ instanceCount: 0, launcherAlive: false }) },
    { taskState: async () => ({ instanceCount: 0, launcherAlive: false, enabled: true }) },
    { taskState: async () => ({ instanceCount: 1, launcherAlive: true, enabled: false }) },
    { fetchImpl: async () => ({ ok: true }) },
    { fetchImpl: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
    { stopped: () => { throw new Error("recorded process identity is alive or unknown"); } },
    { absent: () => { throw new Error("native runtime process remains"); } },
  ]) await assert.rejects(assertControlledRecoveryOffline({ ...offline(), ...changed }));
});
