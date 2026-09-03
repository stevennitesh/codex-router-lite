import path from "node:path";
import { fileURLToPath } from "node:url";

import { readControlHealth } from "./control-health.mjs";
import {
  providerSelectionStatus,
  writeProviderSelection,
} from "./provider-selection.mjs";
import {
  readMultiAgentSettings,
  setMultiAgentMode,
  setMultiAgentModel,
  setSubagentEffort,
  subagentSettingsSnapshot,
} from "./multi-agent-state.mjs";
import { LISTED_MODELS, MODEL_BY_SLUG } from "./routed-models.mjs";
import { modelPickerSnapshot, setModelVisible } from "./model-picker-state.mjs";
import { runServiceCli } from "./service.mjs";

const args = process.argv.slice(2);
const slugs = new Set(LISTED_MODELS.map((model) => model.slug));

function requireRoute(slug) {
  if (!slugs.has(slug)) throw new Error(`Unknown routed model: ${slug}`);
  return MODEL_BY_SLUG.get(slug);
}

function requireCertifiedRoute(slug) {
  const route = requireRoute(slug);
  if (route.multiAgentVersion !== "v2") {
    throw new Error(`${slug} is not certified for subagents v2.`);
  }
  return route;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command = "health", action = "status", value, extra] = args;
  if (command === "health") {
    print(await readControlHealth());
    return;
  }
  if (command === "providers") {
    if (action === "status") print(providerSelectionStatus());
    else if (action === "set") print({ providers: writeProviderSelection(args.slice(2).flatMap((entry) => entry.split(","))) });
    else throw new Error("Usage: control providers status|set <openrouter,switchyard>");
    return;
  }
  if (command === "picker") {
    if (action === "status") print(modelPickerSnapshot());
    else if (action === "show" || action === "hide") {
      requireRoute(value);
      setModelVisible(value, action === "show");
      print(modelPickerSnapshot());
    } else {
      throw new Error("Usage: control picker status|show|hide <route>");
    }
    return;
  }
  if (command === "subagents") {
    if (action === "status") {
      print({
        settings: readMultiAgentSettings(),
        snapshot: subagentSettingsSnapshot(),
        routes: LISTED_MODELS.map(({ slug, multiAgentVersion }) => ({ slug, multiAgentVersion })),
      });
    } else if (["all", "selected", "proven"].includes(action)) {
      print(setMultiAgentMode(action));
    } else if (action === "on" || action === "off") {
      requireCertifiedRoute(value);
      print(setMultiAgentModel(value, action === "on"));
    } else if (action === "effort") {
      requireRoute(value);
      print(setSubagentEffort(value, extra));
    } else {
      throw new Error("Usage: control subagents status|all|selected|proven|on <route>|off <route>|effort <route> <level>");
    }
    return;
  }
  if (command === "service") {
    await runServiceCli(args.slice(1));
    return;
  }
  throw new Error("Usage: control health|providers|picker|subagents|service");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
