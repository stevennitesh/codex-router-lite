import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createStopBrowserState } from "../src/web-browser-state.mjs";

const fixturePath = new URL("../test/fixtures/web-stop-browser.html", import.meta.url);
const fixtureRoute = "/web-stop-browser.html";
const generationTurnKey = "fixture-owned-generation";
const ui = Object.freeze({
  turnSelector: "[data-turn-key]", turnKeyAttribute: "data-turn-key",
  turnStateSelector: "[data-talvt-turn-state]", turnStateAttribute: "data-talvt-turn-state",
  completeTurnState: "complete",
});
const scenarios = Object.freeze({
  "hidden-stop-idle": "Hidden Stop with idle",
  "labelledby-transition": "Labelledby transition",
  "normalized-transition": "Normalized names transition",
  "duplicate-stop": "Duplicate Stop",
  "duplicate-idle": "Duplicate idle",
  "changed-generation": "Changed latest generation",
  "click-idle-transition": "Click restores idle",
  "absent-unconfirmed": "Absent unconfirmed",
  "explicit-complete": "Explicit complete",
  "sdk-capped-readiness": "Click restores idle",
});

function requireContract(value, code) {
  if (!value) throw Object.assign(new Error(code), { contractCode: code });
}

function fixtureUrlOnly(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.pathname !== fixtureRoute || url.search || url.hash || url.username || url.password) {
    throw new Error("The browser contract requires the isolated loopback fixture URL.");
  }
  return url.href;
}

/** Serve only the fixed public fixture; the server never exposes workspace files. */
export async function serveWebStopBrowserFixture() {
  const html = await readFile(fixturePath);
  const server = createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method) || request.url !== fixtureRoute) {
      response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : html);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { fixtureUrl: `http://127.0.0.1:${address.port}${fixtureRoute}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/**
 * Run in the official native Node REPL with a disposable installed-SDK tab.
 * Every mutation uses a real fixture button click; evaluations are read-only.
 * Results contain fixed case/code values and bounded primitive evidence only.
 */
export async function runWebStopBrowserContract({ tab, fixtureUrl, timeoutMs = 2000,
  cases = Object.keys(scenarios) } = {}) {
  fixtureUrl = fixtureUrlOnly(fixtureUrl);
  if (!tab?.playwright || typeof tab.goto !== "function" || typeof tab.url !== "function"
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000
      || !Array.isArray(cases) || cases.length === 0 || cases.some(name => !Object.hasOwn(scenarios, name))
      || new Set(cases).size !== cases.length) throw new Error("Invalid browser contract options.");
  const initialUrl = await tab.url();
  if (initialUrl !== fixtureUrl && initialUrl !== "about:blank") {
    throw new Error("The browser contract requires a disposable blank tab or its own fixture tab.");
  }
  if (initialUrl !== fixtureUrl) await tab.goto(fixtureUrl);
  await tab.playwright.getByRole("heading", { name: "Router Stop browser contract fixture", exact: true })
    .waitFor({ state: "visible", timeoutMs });
  const results = [];
  const status = () => tab.playwright.locator("#contract-status").evaluate(element => ({
    scenario: element.getAttribute("data-scenario"),
    stopClicks: Number(element.getAttribute("data-stop-clicks")),
  }), undefined, { timeoutMs });
  const mountedStops = () => tab.playwright.locator('[data-fixture-control="stop"]').evaluateAll(elements => ({
    mounted: elements.length,
    hidden: elements.filter(element => element.hidden && element.isConnected).length,
  }), undefined, { timeoutMs });

  for (const name of cases) {
    try {
      // These exact names come from this fixture's public scenario controls.
      await tab.playwright.getByRole("button", { name: scenarios[name], exact: true }).click({ timeoutMs });
      const selected = await status();
      requireContract(selected.scenario === (name === "sdk-capped-readiness" ? "click-idle-transition" : name)
        && selected.stopClicks === 0, "scenario_not_selected");
      const state = createStopBrowserState(tab, { ui, generationTurnKey, stopName: "Stop", idleName: "Start Voice" });
      const before = await state.inspect({ timeoutMs });
      requireContract(before.url === fixtureUrl && before.matchingCount === 1
        && before.latestTurnKey === generationTurnKey, "initial_generation_not_owned");

      if (name === "hidden-stop-idle") {
        const mounted = await mountedStops();
        requireContract(mounted.mounted === 1 && mounted.hidden === 1, "hidden_stop_not_mounted");
        requireContract(before.complete === false && before.inactive === false, "idle_without_click_confirmed");
        // Timeout is only a failure bound. Successful resolution proves the
        // actual predicate accepted idle despite the still-mounted hidden Stop.
        await state.ready(true).waitFor({ state: "visible", timeoutMs });
        const after = await state.inspect({ allowComposerRestored: true, timeoutMs });
        const retained = await mountedStops();
        requireContract(after.inactive === true && after.stopVisible === false
          && retained.mounted === 1 && retained.hidden === 1, "hidden_stop_blocked_idle_readiness");
        results.push({ case: name, passed: true, hiddenStopMounted: true, readinessResolved: true });
      } else if (name === "sdk-capped-readiness") {
        requireContract(before.stopVisible === true && before.inactive === false, "initial_state_not_active");
        const deadline = Date.now() + 10000;
        let waits = 0, activeRead = false;
        // The real SDK's first bounded wait must expire while the fixture is
        // active. Only a rearmed wait dispatches the fixture's one real click.
        const after = await state.waitForReadiness({ waitFor: async options => {
          waits += 1;
          if (waits === 2) {
            requireContract(activeRead, "rearm_without_active_read");
            await state.stop.click({ timeoutMs });
          }
          await state.ready(true).waitFor({ ...options, timeoutMs: Math.min(3000, options.timeoutMs) });
        } }, {
          state: "attached",
          nextTimeout: () => deadline - Date.now() - 1500,
          inspect: async () => {
            const view = await state.inspect({ allowComposerRestored: true, timeoutMs });
            if (waits === 1 && view.stopVisible === true && view.inactive === false) activeRead = true;
            return view;
          },
          ready: view => view.inactive,
        });
        const clicked = await status();
        requireContract(waits === 2 && after.inactive === true && after.stopVisible === false
          && clicked.stopClicks === 1, "capped_wait_did_not_rearm");
        results.push({ case: name, passed: true, readinessState: "attached", conditionWaits: waits, activeRead, stopClicks: clicked.stopClicks });
      } else if (["labelledby-transition", "normalized-transition", "click-idle-transition"].includes(name)) {
        requireContract(before.stopVisible === true && before.inactive === false && before.idleAbsent === true,
          "preclick_state_not_active_without_idle");
        await state.stop.click({ timeoutMs });
        await state.ready(true).waitFor({ state: "visible", timeoutMs });
        const after = await state.inspect({ allowComposerRestored: true, timeoutMs });
        const clicked = await status();
        const visibleIdleCount = await tab.playwright.getByRole("button", { name: "Start Voice", exact: true })
          .filter({ visible: true }).count();
        requireContract(after.inactive === true && after.complete === false && after.stopVisible === false
          && visibleIdleCount === 1 && clicked.stopClicks === 1, "acknowledged_click_did_not_restore_idle");
        results.push({ case: name, passed: true, stopClicks: clicked.stopClicks, composerRestored: true });
      } else if (name === "duplicate-stop" || name === "duplicate-idle") {
        const after = await state.inspect({ allowComposerRestored: true, timeoutMs });
        requireContract(after.inactive === false && (name === "duplicate-idle" || after.controlsRecognized === false),
          "duplicate_controls_accepted");
        requireContract(await state.ready(true).count() === 0, "duplicate_controls_ready");
        requireContract((await status()).stopClicks === 0, "duplicate_controls_clicked");
        results.push({ case: name, passed: true, ambiguityRejected: true, stopClicks: 0 });
      } else if (name === "changed-generation") {
        requireContract(before.stopVisible === true, "initial_stop_not_visible");
        await tab.playwright.getByRole("button", { name: "Advance fixture generation", exact: true }).click({ timeoutMs });
        const changed = await state.inspect({ allowComposerRestored: true, timeoutMs });
        requireContract(changed.latestTurnKey === "fixture-successor-generation" && changed.inactive === false,
          "successor_generation_accepted");
        requireContract(await state.stop.count() === 0 && await state.ready(true).count() === 0,
          "stale_generation_locator_matched");
        let rejected = false;
        try { await state.stop.click({ timeoutMs: Math.min(timeoutMs, 300) }); }
        catch { rejected = true; }
        requireContract(rejected && (await status()).stopClicks === 0, "stale_generation_stop_clicked");
        results.push({ case: name, passed: true, staleClickRejected: true, stopClicks: 0 });
      } else if (name === "absent-unconfirmed") {
        const after = await state.inspect({ allowComposerRestored: true, timeoutMs });
        requireContract(before.stopVisible === false && after.inactive === false && after.complete === false
          && await state.ready(true).count() === 0, "absence_established_inactivity");
        results.push({ case: name, passed: true, inactivityConfirmed: false });
      } else if (name === "explicit-complete") {
        await state.ready(false).waitFor({ state: "visible", timeoutMs });
        requireContract(before.inactive === true && before.complete === true && before.stopVisible === false
          && (await status()).stopClicks === 0, "explicit_complete_not_confirmed");
        results.push({ case: name, passed: true, explicitComplete: true, stopClicks: 0 });
      }
    } catch (error) {
      results.push({ case: name, passed: false,
        code: typeof error?.contractCode === "string" ? error.contractCode : "browser_contract_operation_failed" });
    }
  }
  return results;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve") {
    process.stderr.write("Usage: node scripts/test-web-stop-browser.mjs --serve\n");
    process.exitCode = 1;
  } else {
    const fixture = await serveWebStopBrowserFixture();
    process.stdout.write(`${JSON.stringify({ fixtureUrl: fixture.fixtureUrl })}\n`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
      await fixture.close();
      process.exitCode = 0;
    });
  }
}
