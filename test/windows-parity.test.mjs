import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Windows command resolution and process-spawn defects can be misread as
// unrelated failures, so invariants that do not require service mutation are
// asserted against the source.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "src");

const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => ({ name, text: readFileSync(path.join(sourceDir, name), "utf8") }));

test("every detached worker is spawned without a console window", () => {
  // A detached child gets its own console on Windows. The vision-model worker
  // missed the flag and left a console open for the length of a multi-gigabyte
  // pull, while its local-model twin two hundred lines away hid correctly.
  for (const { name, text } of sources) {
    let index = text.indexOf("detached: true");
    while (index !== -1) {
      const options = text.slice(index, index + 240);
      assert.ok(
        options.includes("windowsHide: true"),
        `${name}: a detached spawn near "${options.split("\n")[0].trim()}" must set windowsHide`,
      );
      index = text.indexOf("detached: true", index + 1);
    }
  }
});

test("Windows start uses the managed service and keeps foreground explicit", () => {
  const dispatcher = readFileSync(path.join(root, "model-router.ps1"), "utf8");
  assert.match(dispatcher, /"start"\s*\{[\s\S]{0,800}src\\service\.mjs[\s\S]{0,100}@\("start"\)/);
  assert.match(dispatcher, /--foreground/);
  assert.match(dispatcher, /src\\foreground-start\.mjs/);
});

test("the compatibility refresh stays read-only", () => {
  const refresh = readFileSync(
    path.join(root, "maintenance", "refresh-compatibility-state.ps1"),
    "utf8",
  );
  assert.match(refresh, /check-codex-catalog-compat\.mjs/);
  assert.match(refresh, /src\/doctor\.mjs/);
  assert.match(refresh, /@\("run", "check"\)/);
  assert.match(refresh, /@\("test"\)/);
  assert.doesNotMatch(refresh, /service\.mjs.*(?:install|start|stop|restart)/);
  assert.doesNotMatch(refresh, /provider-key|caller-key|codex exec/);
});

test("the current-Codex catalog check imports the Windows spawn owner", () => {
  const source = readFileSync(
    path.join(root, "scripts", "check-codex-catalog-compat.mjs"),
    "utf8",
  );
  assert.match(source, /from "\.\.\/src\/spawnable-command\.mjs"/u);
  assert.doesNotMatch(source, /spawnableCommand[^\n]+codex-binary\.mjs/u);
});
