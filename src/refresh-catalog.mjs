import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";

function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${script} exited with status ${result.status ?? "unknown"}` +
        (result.stderr ? `: ${result.stderr.trim()}` : "."),
    );
  }
  return result.stdout || "";
}

export function refreshCatalog({ execute = run } = {}) {
  const catalogOutput = execute("catalog.mjs", ["--refresh-native"]);
  execute("litellm-config.mjs");
  return { catalogOutput };
}

function main() {
  const { catalogOutput } = refreshCatalog();
  if (catalogOutput) process.stdout.write(catalogOutput);
  process.stdout.write("Native and routed model catalogs refreshed. Fully quit and reopen Codex.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
