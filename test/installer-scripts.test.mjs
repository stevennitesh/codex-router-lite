import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIRTY_PREVIEW_LIMIT, localModificationsMessage } from "../src/update.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = readFileSync(path.join(root, "install.ps1"), "utf8");

test("the Windows installer accepts only Codex and imports no retired client or UI surface", () => {
  assert.match(installer, /\[ValidateSet\("codex"\)\]/);
  assert.doesNotMatch(
    installer,
    /dsh-config-manager|gemini-config-manager|cursor-config-manager|claude-code-config-manager|openclaw|tray-service|codex-router\.ps1|legacy-migration/,
  );
});

test("installation records ownership before starting the guarded service transaction", () => {
  const manifest = installer.indexOf("src/install-manifest.mjs record");
  const service = installer.indexOf("src/service.mjs install");
  const health = installer.indexOf("src/wait-health.mjs");
  assert.ok(manifest >= 0 && service > manifest && health > service);
});

test("installer rollback removes only configuration and service state created by this run", () => {
  assert.match(installer, /\$ConfigWasEnabled/);
  assert.match(installer, /\$ServiceWasInstalled/);
  assert.match(installer, /if \(\$ServiceInstalled -and -not \$ServiceWasInstalled\)/);
  assert.match(installer, /if \(-not \$ConfigWasEnabled\)[\s\S]*\$ConfigDisableCommand/);
});

test("both Python installation branches require the checked-in hash lock", () => {
  const commands = installer
    .split(/\r?\n/)
    .filter((line) => /(?:uv pip install|-m pip install)/.test(line))
    .filter((line) => /requirements\/python\.txt/.test(line));
  assert.equal(commands.length, 2);
  assert.ok(commands.every((line) => line.includes("--require-hashes")));
  assert.match(installer, /uv venv --clear --python 3\.12 \.venv/);
  assert.match(installer, /-m venv --clear \.venv/);
});

test("the PowerShell dirty-checkout message matches the update module", () => {
  assert.match(installer, new RegExp(`\\$DirtyPreviewLimit = ${DIRTY_PREVIEW_LIMIT}`));
  const changes = ["M src/router.mjs", "M install.ps1"];
  const expected = localModificationsMessage(changes, "C:\\router");
  assert.match(expected, /2 tracked files/);
  assert.match(expected, /git -C C:\\router stash/);
  assert.match(expected, /--force/);
});

test("prepare-only never receives the foreign-state ownership override", () => {
  const prepare = installer.indexOf("if (-not $PrepareOnly)");
  const override = installer.indexOf('$env:MODEL_ROUTER_ALLOW_FOREIGN_STATE = "1"');
  assert.ok(prepare >= 0 && override > prepare);
  assert.match(installer, /Remove-Item Env:\\MODEL_ROUTER_ALLOW_FOREIGN_STATE/);
});
