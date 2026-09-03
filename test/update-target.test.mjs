import assert from "node:assert/strict";
import test from "node:test";

import {
  checkForUpdate,
  currentCheckoutInstaller,
  installationNeedsRefresh,
  localModificationsMessage,
  parseArguments,
  resolveCommand,
} from "../src/update.mjs";

test("checkout updates use only the Windows Codex installer", () => {
  const windowsCodex = currentCheckoutInstaller("win32", "codex");
  assert.equal(windowsCodex.command, "powershell.exe");
  assert.deepEqual(windowsCodex.args.slice(-2), ["-Target", "codex"]);
  assert.throws(() => currentCheckoutInstaller("linux", "codex"), /Unsupported installer platform/);
  assert.throws(() => currentCheckoutInstaller("win32", "gemini"), /Unsupported client target/);
});

test("a bare invocation updates and an explicit check stays read-only", () => {
  assert.equal(resolveCommand([]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["check"]), checkForUpdate);
  assert.notEqual(resolveCommand(["check"]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["nonsense"]), undefined);
});

test("an update reinstalls a revision pulled outside the updater", () => {
  assert.equal(installationNeedsRefresh(undefined, "new-revision"), true);
  assert.equal(
    installationNeedsRefresh({ current: { commit: "old-revision" } }, "new-revision"),
    true,
  );
  assert.equal(
    installationNeedsRefresh({ current: { commit: "new-revision" } }, "new-revision"),
    false,
  );
});

test("--force is a flag on a command, never mistaken for one", () => {
  assert.equal(resolveCommand(["--force"]), resolveCommand(["update"]));
  assert.equal(resolveCommand(["check", "--force"]), checkForUpdate);

  assert.deepEqual(parseArguments([]), { command: resolveCommand(["update"]), force: false });
  assert.deepEqual(parseArguments(["--force"]), {
    command: resolveCommand(["update"]),
    force: true,
  });
  assert.deepEqual(parseArguments(["rollback", "--force"]), {
    command: resolveCommand(["rollback"]),
    force: true,
  });
  assert.equal(parseArguments(["nonsense"]).command, undefined);
});

test("a refused update names the files in the way and both ways forward", () => {
  const message = localModificationsMessage([" M src/router.mjs", " M bin/install"], "/tmp/checkout");
  assert.match(message, /2 tracked files/);
  // Whoever hits this has to be able to see what is holding the update, or
  // they are stuck on an old version with no way to work out why.
  assert.match(message, /src\/router\.mjs/);
  assert.match(message, /bin\/install/);
  assert.match(message, /git -C \/tmp\/checkout stash/);
  assert.match(message, /--force/);
});

test("a long list of local changes is previewed, not dumped", () => {
  const changes = Array.from({ length: 14 }, (_, index) => ` M src/file-${index}.mjs`);
  const message = localModificationsMessage(changes, "/tmp/checkout");
  assert.match(message, /14 tracked files/);
  assert.match(message, /src\/file-9\.mjs/);
  assert.equal(message.includes("src/file-10.mjs"), false);
  assert.match(message, /\.\.\.and 4 more/);
});

test("a single local change reads as one file, not one files", () => {
  assert.match(localModificationsMessage([" M src/router.mjs"]), /1 tracked file;/);
});

// The reviewer of #186 flagged that control.mjs's Windows apply branch was a
// hand-rolled PowerShell argument list with no test. It now reuses this helper,
// so the branch is covered here rather than being a second untested copy.
test("the enable path uses the Windows checkout entry point", () => {
  const windows = currentCheckoutInstaller("win32", "codex");
  assert.equal(windows.command, "powershell.exe");
  assert.ok(windows.args.includes("-CheckoutInstall"));
  assert.ok(windows.args.some((argument) => argument.endsWith("install.ps1")));
  assert.deepEqual(windows.args.slice(-2), ["-Target", "codex"]);
});
