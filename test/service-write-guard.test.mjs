import assert from "node:assert/strict";
import test from "node:test";

import {
  assertServiceWriteIsolated,
  serviceManagerDisabled,
  skipServiceManagerCall,
} from "../src/service-write-guard.mjs";

test("outside a test run the write guard does not interfere", () => {
  assert.doesNotThrow(() => assertServiceWriteIsolated("C:\\service", { env: {} }));
});

test("inside a test run an unredirected service write is refused", () => {
  assert.throws(
    () => assertServiceWriteIsolated("C:\\service", {
      env: { NODE_TEST_CONTEXT: "child-v8" },
      label: "Windows Scheduled Task",
    }),
    /Refusing to write the Windows Scheduled Task/,
  );
});

test("a redirected Windows service write is allowed", () => {
  assert.doesNotThrow(() => assertServiceWriteIsolated("C:\\fixture", {
    redirected: true,
    env: { NODE_TEST_CONTEXT: "child-v8" },
  }));
});

test("test mode suppresses host service mutations but leaves external stubs usable", () => {
  assert.equal(skipServiceManagerCall({ env: { NODE_TEST_CONTEXT: "child-v8" } }), true);
  assert.equal(skipServiceManagerCall({
    hostManaged: false,
    env: { NODE_TEST_CONTEXT: "child-v8" },
  }), false);
  assert.equal(serviceManagerDisabled({ MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1" }), true);
});
