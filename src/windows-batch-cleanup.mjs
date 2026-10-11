import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// taskkill can report failure after killing a waiting batch descendant: cmd
// exits before taskkill reaches its root. A native handle witness distinguishes
// that completed tree from an incomplete cleanup without parsing OS messages.
export function stopWindowsBatchChild(child, lifecycle) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const shellPath = systemRoot && path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const shell = shellPath && existsSync(shellPath) ? shellPath : "powershell.exe";
  const deadline = Date.now() + 5_000;
  return new Promise((resolve, reject) => {
    const witness = spawn(shell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(import.meta.dirname, "windows-batch-cleanup.ps1"),
      "-RootPid", String(child.pid), "-ParentPid", String(process.pid),
      "-LaunchedAfterMs", String(lifecycle.launchedAfterMs),
      "-LaunchedBeforeMs", String(lifecycle.launchedBeforeMs),
      "-ExpectedExecutable", lifecycle.executable,
      "-DeadlineMs", String(deadline),
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 5_000 });
    let failure;
    let diagnostic = "";
    witness.stderr.setEncoding("utf8");
    witness.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(0, 1_024); });
    let output = "";
    let outputSize = 0;
    let killer;
    let killerClosed;
    let nativeResult;
    let receipt;
    let witnessClosed = false;
    witness.once("error", error => { failure = error; });
    witness.stdin.on("error", error => { failure ??= error; });
    witness.stdout.setEncoding("utf8");
    witness.stdout.on("data", chunk => {
      output += chunk;
      outputSize += chunk.length;
      if (outputSize > 1_024) { witness.kill(); return; }
      for (let newline; (newline = output.indexOf("\n")) !== -1;) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { witness.kill(); return; }
        if (message.ready === true && !killer) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) { witness.kill(); return; }
          // Keep native output handles and termination custody at their original
          // Node owner. The observer holds generations before admitting this kill.
          killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore", windowsHide: true, timeout: remaining,
          });
          let nativeFailure;
          killer.once("error", error => { nativeFailure = error; });
          killerClosed = new Promise(done => killer.once("close", (code, signal) => {
            const complete = !nativeFailure && !signal && !killer.killed && Number.isInteger(code);
            nativeResult = { nativeCode: code, complete };
            if (!witnessClosed && !witness.stdin.destroyed && !witness.stdin.writableEnded) {
              witness.stdin.end(JSON.stringify(nativeResult) + "\n");
            }
            done();
          }));
        } else if (message.complete === true && killer) {
          receipt = message;
        } else {
          witness.kill();
          return;
        }
      }
    });
    witness.once("close", async (code, signal) => {
      witnessClosed = true;
      if (killer && killer.exitCode === null && killer.signalCode === null) killer.kill();
      await killerClosed;
      if (!failure && !signal && code === 0 && receipt?.complete === true &&
          nativeResult?.complete && receipt.nativeCode === nativeResult.nativeCode &&
          (receipt.nativeCode === 0 || receipt.proof === "held-handles")) {
        resolve(receipt);
      } else {
        const detail = diagnostic.trim();
        reject(failure ?? new Error(`Optional Windows child tree cleanup failed.${detail ? ` ${detail}` : ""}`));
      }
    });
  });
}
