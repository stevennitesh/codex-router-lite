import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { browserDom, readBrowserReplies } from "../src/web-browser.mjs";
import { createObservationBrowserState } from "../src/web-browser-state.mjs";

const fixturePath = new URL("../test/fixtures/web-send-browser.html", import.meta.url);
const route = "/web-send-browser.html";
const generationTurnKey = "22222222-2222-4222-8222-222222222222";
const generationMarker = "Router generation: fixture-send-generation";
const scenarios = {
  "optimistic-bubble": ["Optimistic bubble only", false],
  "owned-error": ["Error inside owned turn", true],
  "sibling-error": ["Error after owned turn", true],
  "attachment-error": ["Restored attachment error", true],
  "quoted-user": ["Quoted error in user text", false],
  "quoted-assistant": ["Quoted error in assistant text", false],
  "older-error": ["Error in older turn", false],
  "draft-only": ["Restored draft alone", false],
  "edited-draft": ["Error with edited draft", false],
  "accepted-answer": ["Accepted answer", false],
  "structured-answer": ["Structured answer", false],
};

export async function serveWebSendBrowserFixture() {
  const html = await readFile(fixturePath);
  const server = createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method) || request.url !== route) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'" });
    response.end(request.method === "HEAD" ? undefined : html);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { fixtureUrl: `http://127.0.0.1:${server.address().port}${route}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/** Exercises the production read-only DOM projection through the installed browser SDK. */
export async function runWebSendBrowserContract({ tab, fixtureUrl, timeoutMs = 2000, readReplies = readBrowserReplies } = {}) {
  const url = new URL(fixtureUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== route
      || url.search || url.hash || url.username || url.password) throw new Error("Invalid Send fixture URL.");
  const initialUrl = await tab.url();
  if (initialUrl !== "about:blank" && initialUrl !== url.href) throw new Error("A disposable fixture tab is required.");
  if (initialUrl !== url.href) await tab.goto(url.href);
  await tab.playwright.getByRole("heading", { name: "Router Send browser contract fixture", exact: true })
    .waitFor({ state: "visible", timeoutMs });
  const results = [];
  for (const [name, [label, expectedError]] of Object.entries(scenarios)) {
    await tab.playwright.getByRole("button", { name: label, exact: true }).click({ timeoutMs });
    const before = await tab.playwright.getByRole("textbox", { name: browserDom.composerName, exact: true }).textContent({ timeoutMs });
    try {
      const controls = createObservationBrowserState(tab, { ui: browserDom, generationTurnKey });
      const options = { ui: browserDom,
        assistantSelector: browserDom.assistantFinalReplySelector, regenerateName: browserDom.regenerateButtonExactName,
        generationTurnKey, generationMarker,
        submittedComposerText: name === "attachment-error" ? `Pasted text.txt\n${generationMarker}` : `Fixture request.\n${generationMarker}` };
      const read = (selection, projection) => selection.evaluateAll(readReplies, { ...options, ...projection }, { timeoutMs });
      // These scenarios are idle. Use the same guarded quiet profile, dedicated
      // indicator unions and fresh answer frame as production observation.
      const readProfile = quiet => read(controls.profile(false, quiet)
        .or(tab.playwright.locator(`${browserDom.turnSelector},${browserDom.assistantFinalReplySelector}`)).or(controls.regenerate),
      { observation: true, stopVisible: false });
      let projection = await readProfile(true);
      if (!projection) {
        const full = await read(controls.indicatorBody.or(controls.fullBanner).or(controls.fullButton), { indicator: "full" });
        const error = await read(controls.indicatorBody.or(tab.playwright.locator(browserDom.turnSelector))
          .or(controls.requestError).or(controls.retry).or(controls.composer), { indicator: "error" });
        projection = await readProfile(false);
        if (!full || !error || full.url !== url.href || error.url !== url.href) throw new Error("Fixture indicator proof is unavailable.");
        if (projection && projection.turns.filter(turn => turn.turnKey === generationTurnKey).length === 1
            && projection.turns.at(-1)?.turnKey === generationTurnKey) Object.assign(projection.observation,
          { conversationFull: full.conversationFull }, error.requestError ? { requestError: error.requestError } : {});
      }
      if (!projection || projection.observation.url !== url.href) throw new Error("Fixture observation proof is unavailable.");
      const after = await tab.playwright.getByRole("textbox", { name: browserDom.composerName, exact: true }).textContent({ timeoutMs });
      const retries = await tab.playwright.locator("#contract-status").getAttribute("data-retries", { timeoutMs });
      const error = projection.observation.requestError ?? null;
      const acceptedText = name !== "accepted-answer" || projection.replies.some(reply => reply.text === "FIXTURE_ACCEPTED");
      const structuredText = name !== "structured-answer" || projection.replies.length === 1
        && projection.replies[0].text === "See guidance.\n\nNameValue\nAlphaBeta\n\n  literal ``` fence\n\n    indented\n\n\nFirst\nSecond\n\nDone."
        && projection.replies[0].renderedText === "See [guidance](<https://example.test/guide?q=a%20b>).\n\n| Name | Value |\n| --- | --- |\n| Alpha | Beta |\n\n````\n  literal ``` fence\n\n    indented\n````\n\n3. First\n4. Second\n\nDone.";
      results.push({ case: name, passed: error === (expectedError ? "unknown_error" : null) && before === after
        && retries === "0" && acceptedText && structuredText, requestError: error, draftPreserved: before === after, retryClicks: Number(retries) });
    } catch {
      results.push({ case: name, passed: false, code: "browser_contract_operation_failed" });
    }
  }
  return results;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve") {
    process.stderr.write("Usage: node scripts/test-web-send-browser.mjs --serve\n");
    process.exitCode = 1;
  } else {
    const fixture = await serveWebSendBrowserFixture();
    process.stdout.write(`${JSON.stringify({ fixtureUrl: fixture.fixtureUrl })}\n`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await fixture.close(); process.exitCode = 0; });
  }
}
