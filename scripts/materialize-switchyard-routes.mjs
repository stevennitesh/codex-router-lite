import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSwitchyardConfigContract,
  validateSwitchyardConfigContract,
} from "./switchyard-config-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
const routerBase = process.argv[3];
if (!output || !routerBase || process.argv.length !== 4) {
  throw new Error("usage: materialize-switchyard-routes.mjs OUTPUT ROUTER_BASE");
}
const sourcePath = path.join(root, "config", "switchyard", "routes.template.toml");
const source = readFileSync(sourcePath, "utf8").replace(/\r\n/gu, "\n");
const placeholder = "__CODEX_ROUTER_INTERNAL_RESPONSES_BASE_URL__";
if (source.split(placeholder).length !== 2) {
  throw new Error("Canonical Switchyard route template lacks its private Router URL placeholder");
}
const routeModel = JSON.parse(readFileSync(
  path.join(root, "config", "switchyard", "auto.json"),
  "utf8",
)).models[0];
validateSwitchyardConfigContract(parseSwitchyardConfigContract(source, routeModel));
writeFileSync(output, source.replace(placeholder, routerBase));
