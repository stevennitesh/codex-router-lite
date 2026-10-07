import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkSyntax, syntaxCheckFiles } from "../scripts/check-syntax.mjs";

test("syntax checks cover maintenance and nested fixtures without executing them", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-syntax-"));
  try {
    for (const directory of ["scripts", "src", "test/fixtures", "maintenance"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    const marker = path.join(root, "must-not-execute");
    const files = ["root.mjs", "src/module.mjs", "test/fixtures/fixture.mjs", "maintenance/preflight.mjs"];
    for (const file of files) {
      writeFileSync(path.join(root, file), `await import("node:fs").then(fs => fs.writeFileSync(${JSON.stringify(marker)}, "ran"));`);
    }
    writeFileSync(path.join(root, "maintenance", "ignored.ps1"), "not JavaScript");
    assert.deepEqual(syntaxCheckFiles(root), files.map(file => path.join(root, file)).sort());
    await checkSyntax(syntaxCheckFiles(root));
    assert.equal(existsSync(marker), false);
    writeFileSync(path.join(root, "maintenance", "preflight.mjs"), "export const broken = ;");
    await assert.rejects(checkSyntax(syntaxCheckFiles(root)), /Syntax check failed:.*preflight\.mjs/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syntax checking reports a missing input file as a failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-syntax-missing-"));
  try {
    await assert.rejects(checkSyntax([path.join(root, "missing.mjs")]), /Syntax check failed/);
    await assert.rejects(checkSyntax([], { concurrency: 0 }), /positive integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
