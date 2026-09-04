import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { newestCodexBinary } from "../src/codex-binary.mjs";

test("equal-version Codex app binaries select the newest installed build", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-binary-"));
  const oldBinary = path.join(testRoot, "old.exe");
  const newBinary = path.join(testRoot, "new.exe");
  writeFileSync(oldBinary, "old");
  writeFileSync(newBinary, "new");
  try {
    assert.equal(
      newestCodexBinary(
        [oldBinary, newBinary],
        () => "codex-cli 1.2.3",
        (candidate) => candidate === newBinary ? 2 : 1,
      ),
      newBinary,
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
