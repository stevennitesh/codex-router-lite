import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkSyntax, syntaxCheckFiles } from "./scripts/check-syntax.mjs";
import {
  readSwitchyardConfigContract,
  validateSwitchyardConfigContract,
} from "./scripts/switchyard-config-contract.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
await checkSyntax(syntaxCheckFiles(root));

execFileSync(process.execPath, [path.join(root, "src", "install-plan.mjs"), "verify-lock"], {
  stdio: "inherit",
});

execFileSync(process.execPath, [path.join(root, "scripts", "check-product-boundary.mjs")], {
  stdio: "inherit",
});

execFileSync(process.execPath, [path.join(root, "scripts", "check-v2-agent-applications.mjs")], {
  stdio: "inherit",
});

validateSwitchyardConfigContract(readSwitchyardConfigContract(root));

console.log("syntax checks passed");
