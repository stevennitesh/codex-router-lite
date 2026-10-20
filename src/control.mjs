import path from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";

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
  readSubagentProtocol,
  setSubagentProtocol,
} from "./multi-agent-state.mjs";
import { LISTED_MODELS, MODEL_BY_SLUG } from "./routed-models.mjs";
import { modelPickerSnapshot, setModelVisible, seedWebModelsVisible } from "./model-picker-state.mjs";
import { runServiceCli } from "./service.mjs";
import { readJsonFile } from "./file-probe.mjs";
import { writePrivateFile } from "./file-security.mjs";
import { promptForSecret } from "./secret-prompt.mjs";
import { readWebMaintenanceStatus, webTunnelKeyStatus } from "./web-status.mjs";
import {
  configureInAppWebBridge,
  disconnectWebBridge,
  readWebBridgeSettings,
  webBridgeModels,
  webBridgeStatus,
  WEB_BRIDGE_TUNNEL_KEY_PATH,
} from "./chatgpt-web.mjs";

const args = process.argv.slice(2);
function requireRoute(slug) {
  const model = MODEL_BY_SLUG.get(slug) || webBridgeModels().find((model) => model.slug === slug);
  if (!model) throw new Error(`Unknown routed model: ${slug}`);
  return model;
}

function requireCertifiedRoute(slug) {
  const route = requireRoute(slug);
  if (readSubagentProtocol() === "v1") return route;
  if (route.multiAgentVersion !== "v2") {
    throw new Error(`${slug} is not certified for subagents v2.`);
  }
  return route;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function webTunnelKeyCommand(operation) {
  if (operation === "status") return webTunnelKeyStatus();
  if (operation === "set") {
    const secret = promptForSecret("ChatGPT Web tunnel runtime key").trim();
    if (!secret || /[\u0000-\u001f\u007f]/u.test(secret)) throw new Error("The tunnel runtime key is empty or contains control characters. Nothing was saved.");
    writePrivateFile(WEB_BRIDGE_TUNNEL_KEY_PATH, `${secret}\n`);
    return { configured: true, fileStatus: "present", storage: "protected file" };
  }
  if (operation === "remove") {
    let removed = false;
    try { unlinkSync(WEB_BRIDGE_TUNNEL_KEY_PATH); removed = true; }
    catch (error) { if (error?.code !== "ENOENT") throw new Error("Cannot remove the protected ChatGPT Web tunnel key."); }
    return { configured: false, removed };
  }
  throw new Error("Usage: control web tunnel-key set|status|remove (set prompts without echo; never supply a key argument)");
}

async function main() {
  const [command = "health", action = "status", value, extra] = args;
  if (command === "health") {
    print(await readControlHealth());
    return;
  }
  if (command === "providers") {
    if (action === "status") print(providerSelectionStatus());
    else if (action === "set") print({ providers: await writeProviderSelection(args.slice(2).flatMap((entry) => entry.split(","))) });
    else throw new Error("Usage: control providers status|set <openrouter,switchyard>");
    return;
  }
  if (command === "picker") {
    if (action === "status") print(modelPickerSnapshot({ diagnostic: true }));
    else if (action === "show" || action === "hide") {
      requireRoute(value);
      print(await setModelVisible(value, action === "show"));
    } else {
      throw new Error("Usage: control picker status|show|hide <route>");
    }
    return;
  }
  if (command === "web") {
    if (action === "status") print(await readWebMaintenanceStatus());
    else if (action === "browser") {
      if (!value || args.length !== 3) throw new Error("Usage: control web browser <safe-config-json-file>");
      const config = readJsonFile(value);
      if (config.status !== "present") throw new Error(`Cannot read the safe in-app Web configuration JSON file (${config.status}).`);
      const status = await configureInAppWebBridge(config.value);
      await seedWebModelsVisible(webBridgeModels().map((model) => model.slug));
      print({ ...status, subagentProtocol: readSubagentProtocol(), catalogRefreshRequired: true,
        next: "Run model-router.ps1 codex refresh-catalog, then reopen Codex. Web subagents require V1; configuration does not change the protocol." });
    } else if (action === "tunnel-key") {
      if (args.length > 3) throw new Error("Tunnel keys must be entered at the hidden prompt, never in command arguments.");
      print(webTunnelKeyCommand(value ?? "status"));
    } else if (action === "stop") {
      const operation = value ?? "adapter-status";
      if (["install-adapter", "adapter-status", "adapter-rollback"].includes(operation)) {
        const { installWebStopAdapter, webStopAdapterStatus, rollbackWebStopAdapter } = await import("./web-stop-adapter-install.mjs");
        if (operation === "adapter-status" && args.length <= 3) print(await webStopAdapterStatus());
        else if (operation === "adapter-rollback" && args.length === 3) print(await rollbackWebStopAdapter());
        else if (operation === "install-adapter" && extra && args.length === 4) {
          const settings = readWebBridgeSettings();
          if (!settings.enabled) throw new Error("Persistent Web Stop requires the configured in-app browser integration.");
          print(await installWebStopAdapter({ manifestPath: path.resolve(extra) }));
        } else throw new Error("Usage: control web stop install-adapter <adapter-manifest-json>|adapter-status|adapter-rollback");
        return;
      }
      throw new Error("Usage: control web stop install-adapter <adapter-manifest-json>|adapter-status|adapter-rollback");
    } else if (action === "disconnect") {
      print({ ...await disconnectWebBridge(), catalogRefreshRequired: true,
        next: "Run model-router.ps1 codex refresh-catalog, then reopen Codex." });
    } else throw new Error("Usage: control web status|browser <safe-config-json-file>|stop install-adapter <adapter-manifest-json>|adapter-status|adapter-rollback|tunnel-key set|status|remove|disconnect");
    return;
  }
  if (command === "subagents") {
    if (action === "status") {
      const snapshot = subagentSettingsSnapshot({ diagnostic: true });
      print({
        ...(snapshot.degraded ? {} : { settings: readMultiAgentSettings() }),
        snapshot,
        web: webBridgeStatus(),
        routes: [...LISTED_MODELS, ...webBridgeModels()].map(({ slug, multiAgentVersion }) => ({ slug, multiAgentVersion })),
      });
    } else if (action === "protocol") {
      if (value === undefined || value === "status") {
        print({ protocol: readSubagentProtocol(), web: webBridgeStatus(),
          webSubagentsAvailable: readSubagentProtocol() === "v1" && webBridgeModels().some(model => model.supportsSubagents !== false) });
      } else {
        print({ ...await setSubagentProtocol(value), web: webBridgeStatus(),
          next: "Run model-router.ps1 codex refresh-catalog, fully quit and reopen Codex, and start a new conversation." });
      }
    } else if (["all", "selected", "proven"].includes(action)) {
      print(await setMultiAgentMode(action));
    } else if (action === "on" || action === "off") {
      requireCertifiedRoute(value);
      print(await setMultiAgentModel(value, action === "on"));
    } else if (action === "effort") {
      requireRoute(value);
      print(await setSubagentEffort(value, extra));
    } else {
      throw new Error("Usage: control subagents status|protocol status|v1|v2|all|selected|proven|on <route>|off <route>|effort <route> <level>");
    }
    return;
  }
  if (command === "service") {
    process.exitCode = await runServiceCli(args.slice(1));
    return;
  }
  throw new Error("Usage: control health|providers|picker|subagents|web|service");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
