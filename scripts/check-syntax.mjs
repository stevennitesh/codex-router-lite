import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function syntaxCheckFiles(root) {
  const files = [];
  function collect(directory, recursive) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(target);
      else if (recursive && entry.isDirectory()) collect(target, true);
    }
  }
  collect(root, false);
  for (const directory of ["scripts", "src", "test", "maintenance"]) {
    collect(path.join(root, directory), true);
  }
  return files.sort();
}

export async function checkSyntax(files, { concurrency = 4 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Syntax check concurrency must be a positive integer");
  }
  let next = 0;
  let failure;
  async function worker() {
    while (!failure && next < files.length) {
      const file = files[next++];
      try {
        await execute(process.execPath, ["--check", file], {
          windowsHide: true,
          encoding: "utf8",
        });
      } catch (error) {
        failure ??= new Error(
          `Syntax check failed: ${file}\n${error.stderr || error.message}`,
          { cause: error },
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  if (failure) throw failure;
}
