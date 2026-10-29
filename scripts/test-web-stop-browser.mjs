import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { browserDom, createHomeBrowserState, createObservationBrowserState, createRecoveryBrowserState, createSendBrowserState, createSendReadyLocator, createStopBrowserState } from "../src/web-browser-state.mjs";
import { readBrowserReplies } from "../src/web-browser.mjs";

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

/** Exercise the production semantic observation projection through the installed SDK. */
export async function runWebObservationBrowserContract({ tab, fixtureUrl, timeoutMs = 2000 } = {}) {
  fixtureUrl = fixtureUrlOnly(fixtureUrl);
  if (!tab?.playwright || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error("Invalid observation contract options.");
  const initialUrl = await tab.url();
  if (initialUrl !== fixtureUrl && initialUrl !== "about:blank") throw new Error("The observation contract requires its own disposable fixture tab.");
  if (initialUrl !== fixtureUrl) await tab.goto(fixtureUrl);
  const results = [];
  const readObservation = (state, stopVisible, quiet = true) => state.profile(stopVisible, quiet)
    .or(tab.playwright.locator(`${browserDom.turnSelector},${browserDom.assistantFinalReplySelector}`))
    .or(state.regenerate).evaluateAll(readBrowserReplies, {
      ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector,
      generationTurnKey, observation: true, stopVisible,
    }, { timeoutMs });
  const cases = [
    ["labelledby-transition", "Labelledby transition", true, true],
    ["normalized-transition", "Normalized names transition", true, true],
    ["hidden-stop-idle", "Hidden Stop with idle", false, true],
    ["duplicate-stop", "Duplicate Stop", false, false],
    ["observation-labelledby", "Observation labelledby completion", false, true],
    ["observation-text", "Observation text completion", false, true],
    ["observation-temporary", "Observation labelledby temporary mode", false, false],
    ["observation-quoted-control", "Observation quoted control", false, true],
    ["observation-indicator-transition", "Observation indicator transition", true, true],
  ];
  for (const [name, button, stopVisible, recognized] of cases) {
    try {
      await tab.playwright.getByRole("button", { name: button, exact: true }).click({ timeoutMs });
      const state = createObservationBrowserState(tab, { ui: browserDom, generationTurnKey });
      if (!recognized) {
        requireContract(await state.profile(true).count() === 0 && await state.profile(false).count() === 0, "ambiguous_or_temporary_profile_accepted");
        results.push({ case: name, passed: true, profileRejected: true });
        continue;
      }
      const transition = name === "observation-indicator-transition";
      const view = await readObservation(state, stopVisible, !transition);
      requireContract(view?.observation?.url === fixtureUrl && view.observation.stopVisible === stopVisible
        && view.observation.temporaryInactive === true && view.turns.length === 1, "semantic_projection_invalid");
      if (transition) {
        await tab.playwright.getByRole("button", { name: "Finish fixture generation", exact: true }).click({ timeoutMs });
        const options = { ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector, generationTurnKey };
        const full = await state.indicatorBody.or(state.fullBanner).or(state.fullButton)
          .evaluateAll(readBrowserReplies, { ...options, indicator: "full" }, { timeoutMs });
        const error = await state.indicatorBody.or(tab.playwright.locator(browserDom.turnSelector))
          .or(state.requestError).or(state.retry).or(state.composer)
          .evaluateAll(readBrowserReplies, { ...options, indicator: "error" }, { timeoutMs });
        const current = await readObservation(state, false, false);
        requireContract(full?.url === fixtureUrl && full.conversationFull === false && error?.url === fixtureUrl
          && error.requestError === undefined && current?.observation?.stopVisible === false
          && current.turns[0].complete === true && current.replies[0]?.completionActionAfter === true,
        "indicator_transition_not_reobserved");
        results.push({ case: name, passed: true, transitionReobserved: true, quotedErrorRejected: true, projectionReads: 4 });
        continue;
      }
      if (name.startsWith("observation-")) {
        requireContract(view.replies.length === 1 && view.replies[0].answer === true
          && view.replies[0].completionActionAfter === true && view.observation.regenerateVisible === true
          && view.observation.regenerateCount === 1, "semantic_completion_not_proven");
      }
      results.push({ case: name, passed: true, stopVisible, projectionReads: 1 });
    } catch (error) {
      results.push({ case: name, passed: false, code: typeof error?.contractCode === "string" ? error.contractCode : "observation_contract_operation_failed" });
    }
  }
  return results;
}

/** Exercise the actual Send locator and projection using explicit render events. */
export async function runWebSendBrowserContract({ tab, fixtureUrl, timeoutMs = 2000 } = {}) {
  fixtureUrl = fixtureUrlOnly(fixtureUrl);
  if (!tab?.playwright || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error("Invalid Send contract options.");
  const initialUrl = await tab.url();
  if (initialUrl !== fixtureUrl && initialUrl !== "about:blank") throw new Error("The Send contract requires its own disposable fixture tab.");
  if (initialUrl !== fixtureUrl) await tab.goto(fixtureUrl);
  const generationMarker = "Router generation: 11111111-2222-4333-8444-555555555555";
  const generationKey = "11112222-3333-4444-8555-666677778888";
  const historyKey = "00000000-1111-4222-8333-444455556666";
  const results = [];
  for (const [name, button] of [["send-disabled", "Disabled Send readiness"], ["send-aria-disabled", "Aria-disabled Send readiness"]]) {
    try {
      await tab.playwright.getByRole("button", { name: button, exact: true }).click({ timeoutMs });
      const ready = createSendReadyLocator(tab, browserDom);
      requireContract(await ready.count() === 0, "disabled_send_reported_ready");
      await tab.playwright.getByRole("button", { name: "Enable fixture Send", exact: true }).click({ timeoutMs });
      await ready.waitFor({ state: "visible", timeoutMs });
      requireContract(await ready.count() === 1
        && await tab.playwright.getByRole("button", { name: browserDom.sendButtonExactName, exact: true }).isEnabled(), "enabled_send_not_ready");
      results.push({ case: name, passed: true, enabledByEvent: true });
    } catch (error) {
      results.push({ case: name, passed: false,
        code: typeof error?.contractCode === "string" ? error.contractCode : "send_contract_operation_failed" });
    }
  }
  const cases = [
    ["send-pending", "Pending Send anchor"],
    ["send-history", "Send with quoted history marker"],
    ["send-duplicate-marker", "Duplicate Send marker"],
    ["send-duplicate-key", "Duplicate Send identity"],
    ["send-foreign-latest", "Superseded Send anchor"],
  ];
  for (const [name, button] of cases) {
    try {
      await tab.playwright.getByRole("button", { name: button, exact: true }).click({ timeoutMs });
      const baselineTurnKeys = name === "send-history" ? [historyKey] : [];
      const state = createSendBrowserState(tab, { ui: browserDom, generationMarker, baselineTurnKeys });
      const read = async () => {
        const view = await createObservationBrowserState(tab, { ui: browserDom, generationTurnKey: "pending" }).indicatorBody
          .or(tab.playwright.locator(browserDom.turnSelector))
          .evaluateAll(readBrowserReplies, { ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector,
            projection: "anchor", dispatch: true, generationMarker, baselineTurnKeys }, { timeoutMs });
        requireContract(view?.dispatch?.url === fixtureUrl && view.dispatch.temporaryInactive === true, "coherent_dispatch_not_proven");
        return state.classify(view);
      };
      const before = await read();
      requireContract(before.anchor === null && await state.ready.count() === 0, "unproved_anchor_ready");
      if (name === "send-pending" || name === "send-history") {
        requireContract(before.blocked === false, "history_or_missing_turn_blocked");
        await tab.playwright.getByRole("button", { name: "Publish pending Send marker", exact: true }).click({ timeoutMs });
        const placeholder = await read();
        requireContract(placeholder.anchor === null && placeholder.blocked === false
          && placeholder.diagnostic.validMarkerCount === 0 && await state.ready.count() === 0, "placeholder_identity_adopted");
        await tab.playwright.getByRole("button", { name: "Publish verified Send identity", exact: true }).click({ timeoutMs });
        await state.ready.waitFor({ state: "attached", timeoutMs });
        const confirmed = await read();
        requireContract(confirmed.anchor === generationKey && confirmed.blocked === false
          && confirmed.diagnostic.keyCount === 1 && confirmed.diagnostic.latestMatches === true, "released_anchor_not_owned");
        results.push({ case: name, passed: true, placeholderRejected: true, releasedIdentityVerified: true });
      } else {
        requireContract(before.blocked === true, "ambiguous_or_superseded_anchor_accepted");
        results.push({ case: name, passed: true, ambiguousOrSupersededRejected: true });
      }
    } catch (error) {
      results.push({ case: name, passed: false,
        code: typeof error?.contractCode === "string" ? error.contractCode : "send_contract_operation_failed" });
    }
  }
  for (const [name, button, rejected] of [["send-temporary", "Temporary Send mode", true],
    ["send-duplicate-mode", "Duplicate Send mode controls", true], ["send-hidden-mode", "Hidden inactive Send mode", false]]) {
    try {
      await tab.playwright.getByRole("button", { name: button, exact: true }).click({ timeoutMs });
      const view = await createObservationBrowserState(tab, { ui: browserDom, generationTurnKey: "pending" }).indicatorBody
        .or(tab.playwright.locator(browserDom.turnSelector))
        .evaluateAll(readBrowserReplies, { ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector,
          projection: "anchor", dispatch: true, generationMarker, baselineTurnKeys: [] }, { timeoutMs });
      requireContract(rejected ? view === null : view?.dispatch?.url === fixtureUrl
        && createSendBrowserState(tab, { ui: browserDom, generationMarker }).classify(view).anchor === generationKey,
      "send_mode_projection_invalid");
      results.push({ case: name, passed: true, modeRejected: rejected, projectionReads: 1 });
    } catch (error) {
      results.push({ case: name, passed: false,
        code: typeof error?.contractCode === "string" ? error.contractCode : "send_contract_operation_failed" });
    }
  }
  return results;
}

/** Startup and recovery waits use the installed SDK, with explicit fixture events. */
export async function runWebLifecycleBrowserContract({ tab, fixtureUrl, timeoutMs = 2000 } = {}) {
  fixtureUrl = fixtureUrlOnly(fixtureUrl);
  if (!tab?.playwright || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error("Invalid lifecycle contract options.");
  const initialUrl = await tab.url();
  if (initialUrl !== fixtureUrl && initialUrl !== "about:blank") throw new Error("The lifecycle contract requires its own disposable fixture tab.");
  if (initialUrl !== fixtureUrl) await tab.goto(fixtureUrl);
  const results = [], click = name => tab.playwright.getByRole("button", { name, exact: true }).click({ timeoutMs });
  const record = async (name, run) => {
    try { results.push({ case: name, passed: true, ...await run() }); }
    catch (error) { results.push({ case: name, passed: false,
      code: typeof error?.contractCode === "string" ? error.contractCode : "lifecycle_contract_operation_failed" }); }
  };
  await record("home-hydration", async () => {
    await click("Home hydration");
    const state = createHomeBrowserState(tab, { ui: browserDom });
    requireContract(await state.ready.count() === 0 && await state.inspect(timeoutMs) === null, "unhydrated_home_ready");
    await click("Hydrate fixture home");
    await state.ready.waitFor({ state: "attached", timeoutMs });
    requireContract(await state.ready.count() === 1, "hydrated_home_not_ready");
    // A semantic wake never bypasses the authoritative ChatGPT-origin proof.
    requireContract(await state.inspect(timeoutMs) === false, "foreign_origin_home_accepted");
    return { hydrationEventObserved: true, foreignOriginRejected: true };
  });
  for (const [name, button] of [["home-duplicate", "Duplicate home model"], ["home-temporary", "Temporary home mode"]]) {
    await record(name, async () => {
      await click(button);
      const state = createHomeBrowserState(tab, { ui: browserDom });
      requireContract(await state.ready.count() === 0 && await state.inspect(timeoutMs) === null, "ambiguous_home_ready");
      return { readinessRejected: true };
    });
  }
  const proof = { generationTurnKey, replyId: "00112233-4455-4677-8899-aabbccddeeff",
    assistantPrefix: { length: "Recovered saved answer".length }, completed: true };
  await record("recovery-render-events", async () => {
    await click("Recovery checkpoint render");
    const state = createRecoveryBrowserState(tab, { ui: browserDom, proof });
    const progressing = createRecoveryBrowserState(tab, { ui: browserDom, proof: { ...proof, completed: false } });
    requireContract(await state.ready.count() === 0, "missing_checkpoint_ready");
    await click("Publish recovery checkpoint");
    requireContract(await state.ready.count() === 0 && await progressing.ready.count() === 0, "unrendered_checkpoint_ready");
    await click("Reveal recovery text");
    await progressing.ready.waitFor({ state: "attached", timeoutMs });
    requireContract(await state.ready.count() === 0, "incomplete_checkpoint_ready");
    await click("Complete recovery checkpoint");
    await state.ready.waitFor({ state: "attached", timeoutMs });
    const view = await tab.playwright.locator(`${browserDom.turnSelector},${browserDom.assistantFinalReplySelector}`)
      .evaluateAll(readBrowserReplies, { ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector }, { timeoutMs });
    requireContract(view.turns.length === 1 && view.turns[0].complete === true
      && view.replies.length === 1 && view.replies[0].messageId === proof.replyId
      && view.replies[0].text === "Recovered saved answer", "checkpoint_projection_invalid");
    return { checkpointEventsObserved: true, projectionReads: 1 };
  });
  await record("recovery-formatted", async () => {
    await click("Formatted recovery checkpoint");
    const expected = "Before.\n\nAfter.\n\nfirst\n\nlast";
    const state = createRecoveryBrowserState(tab, { ui: browserDom,
      proof: { ...proof, assistantPrefix: { length: expected.length } } });
    await state.ready.waitFor({ state: "attached", timeoutMs });
    const rawLength = await tab.playwright.locator(`[${browserDom.messageIdAttribute}="${proof.replyId}"]`)
      .evaluate(element => element.textContent.length, undefined, { timeoutMs });
    const view = await tab.playwright.locator(`${browserDom.turnSelector},${browserDom.assistantFinalReplySelector}`)
      .evaluateAll(readBrowserReplies, { ui: browserDom, assistantSelector: browserDom.assistantFinalReplySelector }, { timeoutMs });
    requireContract(rawLength < expected.length && view.replies.length === 1 && view.replies[0].text === expected,
      "formatted_checkpoint_not_preserved");
    return { logicalLinesPreserved: true, rawTextShorterThanCheckpoint: true };
  });
  for (const [name, button] of [["recovery-duplicate-message", "Duplicate recovery message"],
    ["recovery-duplicate-turn", "Duplicate recovery generation"], ["recovery-foreign-latest", "Foreign recovery generation"]]) {
    await record(name, async () => {
      await click(button);
      const state = createRecoveryBrowserState(tab, { ui: browserDom, proof });
      requireContract(await state.ready.count() === 0, "foreign_or_duplicate_checkpoint_ready");
      return { readinessRejected: true };
    });
  }
  await record("exact-url-event", async () => {
    const expected = `${fixtureUrl}#checkpoint`;
    const navigation = tab.playwright.waitForURL(expected, { timeoutMs });
    await tab.playwright.getByRole("link", { name: "Navigate to fixture checkpoint", exact: true }).click({ timeoutMs });
    await navigation;
    requireContract(await tab.url() === expected, "url_event_not_observed");
    // The same API must also observe an event that preceded subscription.
    await tab.playwright.waitForURL(expected, { timeoutMs });
    await tab.goto(fixtureUrl);
    return { exactUrlVerified: true, priorNavigationVerified: true };
  });
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
