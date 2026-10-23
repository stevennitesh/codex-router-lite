// The parent owns this synthetic state directory and releases every barrier.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const root = process.env.TEST_ENSURE_ROOT;
const role = process.env.TEST_ENSURE_ROLE;
const notify = event => process.send?.({ event });
function waitForRelease() {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(path.join(root, `release-${role}`))) {
    if (Date.now() >= deadline) throw new Error("Synthetic ensure barrier was not released.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const lstat = fs.lstatSync;
let observed = false;
fs.lstatSync = function (target, ...args) {
  try { return lstat.call(this, target, ...args); }
  catch (error) {
    if (!observed && String(target) === path.join(root, "caller-secret") && error.code === "ENOENT") {
      observed = true;
      notify("missing");
      waitForRelease();
    }
    throw error;
  }
};
const asyncLstat = fs.promises.lstat;
fs.promises.lstat = async function (target, ...args) {
  const result = await asyncLstat.call(this, target, ...args);
  if (String(target) === path.join(root, "caller-key-rotation.lock")) notify("contended");
  return result;
};
syncBuiltinESMExports();
