import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function render(command) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-render-"));
  try {
    return execFileSync(process.execPath, [path.join(root, "src", "service-windows.mjs"), command], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(fixture, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(fixture, "state with spaces"),
        MODEL_ROUTER_TARGET: "codex",
        CODEX_ROUTER_SERVICE_PLATFORM: "win32",
      },
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("the Windows hidden launcher propagates the wrapper exit code", () => {
  const launcher = render("render-launcher");
  assert.match(launcher, /^Option Explicit\r?\n/);
  assert.match(launcher, /shell\.Run\([\s\S]*, 0, True\)/);
  assert.match(launcher, /WScript\.Quit status/);
});

test("the scheduled task runs the hidden launcher through wscript", () => {
  const task = JSON.parse(render("render-task"));
  assert.equal(task.execute, "wscript.exe");
  assert.match(task.argument, /^\/\/B \/\/NoLogo ".*start-codex-router-hidden\.vbs"$/);
  assert.doesNotMatch(`${task.execute} ${task.argument}`, /cmd\.exe/);
});

test("Windows task mutations retain exact identity and rollback evidence", () => {
  const source = readFileSync(path.join(root, "src", "service-windows.mjs"), "utf8");
  assert.match(source, /\$actions\.Count -eq 1/);
  assert.match(source, /CODEX_ROUTER_TASK_EXECUTE: canonical\.execute/);
  assert.match(source, /\$arguments -ceq \$env:CODEX_ROUTER_TASK_ARGUMENT/);
  assert.match(source, /Export-ScheduledTask/);
  assert.match(source, /GetSecurityDescriptor\(7\)/);
  assert.match(source, /SetSecurityDescriptor\(\[string\]\$payload\.sddl, 0x10\)/);
  assert.match(source, /assertOwnedTask\(installedTask\)/);
  assert.match(source, /missing or foreign task/);
});

test("the service dispatcher names only the Windows renderer", () => {
  const source = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(source, /const script = "service-windows\.mjs"/);
  assert.doesNotMatch(source, /service-(?:macos|linux)\.mjs/);
});
