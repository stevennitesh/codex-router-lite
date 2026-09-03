import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "native-session-"));
const authPath = path.join(home, "auth.json");
process.env.MODEL_ROUTER_CODEX_AUTH = authPath;
process.env.MODEL_ROUTER_STATE_DIR = path.join(home, "state");
delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;

// Every test shares one fixture home; take it down once the file finishes so
// repeated runs do not accumulate temp roots.
after(() => {
  rmSync(home, { recursive: true, force: true });
});

const {
  nativeSessionSharingEnabled,
  nativeSessionAvailable,
  nativeSessionHeaders,
  nativeSessionTokenMatches,
  nativeSessionStatus,
  setNativeSessionSharingEnabled,
  tokenExpiryMs,
} = await import("../src/codex-native-session.mjs");
const { NATIVE_SESSION_CONSENT_PATH } = await import("../src/paths.mjs");

const ACCESS = "sk-test-access-token";
const ACCOUNT = "acct-0123456789";
const API_KEY = "sk-test-codex-api-key";

function writeAuth(tokens) {
  writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens }), "utf8");
}

function writeAuthDocument(document) {
  writeFileSync(authPath, JSON.stringify(document), "utf8");
}

function clearAuth() {
  rmSync(authPath, { force: true });
}

function writeConsentFixture() {
  mkdirSync(path.dirname(NATIVE_SESSION_CONSENT_PATH), { recursive: true });
  writeFileSync(
    NATIVE_SESSION_CONSENT_PATH,
    '{"version":1,"sharing":"enabled"}\n',
    "utf8",
  );
}

const jwtWithClaims = (claims) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test.beforeEach(() => {
  clearAuth();
  setNativeSessionSharingEnabled(false);
  delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
});

test("no session on disk means no fallback rather than an error", () => {
  clearAuth();
  assert.equal(nativeSessionAvailable(), false);
  assert.equal(nativeSessionHeaders(), undefined);
  assert.equal(nativeSessionStatus().present, false);
});

test("a signed-in session stays private until the user authorizes sharing once", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  assert.equal(nativeSessionSharingEnabled(), false);
  assert.equal(nativeSessionHeaders(), undefined);
  assert.equal(nativeSessionStatus().usable, true, "login usability is reported independently");

  setNativeSessionSharingEnabled(true);
  assert.equal(nativeSessionSharingEnabled(), true);
  assert.deepEqual(nativeSessionHeaders(), {
    authorization: `Bearer ${ACCESS}`,
    "chatgpt-account-id": ACCOUNT,
  });
  assert.equal(nativeSessionAvailable(), true);
  assert.equal(existsSync(NATIVE_SESSION_CONSENT_PATH), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(NATIVE_SESSION_CONSENT_PATH).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(readFileSync(NATIVE_SESSION_CONSENT_PATH, "utf8"), /access|account/i);
});

test("shared native session reconstructs the FedRAMP header from Codex identity claims", () => {
  const id_token = jwtWithClaims({
    "https://api.openai.com/auth": { chatgpt_account_is_fedramp: true },
  });
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT, id_token });
  writeConsentFixture();
  assert.equal(nativeSessionHeaders()["x-openai-fedramp"], "true");

  for (const claims of [
    { "https://api.openai.com/auth": { chatgpt_account_is_fedramp: false } },
    {},
  ]) {
    writeAuth({ access_token: ACCESS, account_id: ACCOUNT, id_token: jwtWithClaims(claims) });
    assert.equal(nativeSessionHeaders()["x-openai-fedramp"], undefined);
  }
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT, id_token: "malformed" });
  assert.equal(nativeSessionHeaders()["x-openai-fedramp"], undefined);
});

test("the current Codex session authenticates only its own bearer without enabling sharing", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  assert.equal(nativeSessionSharingEnabled(), false);
  assert.equal(nativeSessionTokenMatches(ACCESS), true);
  assert.equal(nativeSessionTokenMatches("different-session-token"), false);
  clearAuth();
  assert.equal(nativeSessionTokenMatches(ACCESS), false);
});

test("the current Codex API key authenticates requests but never becomes a shared session", () => {
  writeAuthDocument({ auth_mode: "apikey", OPENAI_API_KEY: API_KEY });
  assert.equal(nativeSessionTokenMatches(API_KEY), true);
  assert.equal(nativeSessionTokenMatches("sk-different-api-key"), false);
  assert.equal(nativeSessionHeaders(), undefined);
  assert.equal(nativeSessionAvailable(), false);
  const status = nativeSessionStatus();
  assert.deepEqual(
    {
      present: status.present,
      usable: status.usable,
      hasAccountId: status.hasAccountId,
    },
    { present: true, usable: false, hasAccountId: false },
  );

  // A top-level key in another auth mode is not authority for this route.
  writeAuthDocument({ auth_mode: "chatgpt", OPENAI_API_KEY: API_KEY });
  assert.equal(nativeSessionTokenMatches(API_KEY), false);
});

test("direct Codex authentication uses actual expiry rather than fallback skew", () => {
  const seconds = Math.floor(Date.now() / 1000);
  const nearlyExpired = jwtWithExp(seconds + 30);
  writeAuth({ access_token: nearlyExpired, account_id: ACCOUNT });
  assert.equal(nativeSessionTokenMatches(nearlyExpired), true);
  assert.equal(nativeSessionHeaders(), undefined, "fallback still withholds the near-expiry token");
  const expired = jwtWithExp(seconds - 1);
  writeAuth({ access_token: expired, account_id: ACCOUNT });
  assert.equal(nativeSessionTokenMatches(expired), false);
});
test("sharing cannot be enabled before the user signs in", () => {
  assert.throws(
    () => setNativeSessionSharingEnabled(true),
    /run `codex login`/i,
  );
  assert.equal(existsSync(NATIVE_SESSION_CONSENT_PATH), false);
});

test("status reports presence, never the credential", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  writeConsentFixture();
  const status = nativeSessionStatus();
  assert.equal(status.present, true);
  assert.equal(status.usable, true);
  assert.equal(status.hasAccountId, true);
  assert.equal(status.sharingEnabled, true);
  // The whole point of the status shape: it is safe to print, log, and paste
  // into an issue. A token that reaches any of those has to be rotated.
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, new RegExp(ACCESS));
  assert.doesNotMatch(serialized, new RegExp(ACCOUNT));
});

test("a session with no access token is not a session", () => {
  writeAuth({ account_id: ACCOUNT });
  assert.equal(nativeSessionAvailable(), false);
  assert.equal(nativeSessionStatus().usable, false);

  // A half-written or hand-edited file must not fail a turn; it just means
  // there is nothing to fall back to.
  writeFileSync(authPath, "{ not json", "utf8");
  assert.equal(nativeSessionAvailable(), false);
});

test("the fallback can be switched off", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  writeConsentFixture();
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "0";
  try {
    assert.equal(nativeSessionHeaders(), undefined);
    assert.equal(nativeSessionAvailable(), false);
    assert.equal(nativeSessionStatus().fallbackEnabled, false);
  } finally {
    delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  }
});

test("the environment override is explicit in both directions", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "1";
  assert.equal(nativeSessionAvailable(), true);

  process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "yes";
  assert.equal(nativeSessionAvailable(), false, "an ambiguous value is not consent");
});

test("an unrecognized consent marker fails closed", () => {
  writeAuth({ access_token: ACCESS, account_id: ACCOUNT });
  mkdirSync(path.dirname(NATIVE_SESSION_CONSENT_PATH), { recursive: true });
  writeFileSync(NATIVE_SESSION_CONSENT_PATH, "not json", "utf8");
  assert.equal(nativeSessionAvailable(), false);
  writeFileSync(NATIVE_SESSION_CONSENT_PATH, '{"version":99,"sharing":"enabled"}\n', "utf8");
  assert.equal(nativeSessionAvailable(), false);
});

// The gap that made this "works while you also use Codex" rather than "works":
// the access token has a ten-day life, Codex renews it whenever Codex is used,
// and a harness-only stretch longer than that left the router sending a dead
// token and the user staring at 401s.
const jwtWithExp = (epochSeconds) => jwtWithClaims({ exp: epochSeconds });

test("the expiry claim is read without the token leaving the module", () => {
  const at = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(tokenExpiryMs(jwtWithExp(at)), at * 1000);
  // Anything unreadable is treated as usable: refusing to send a token that
  // might be perfectly good is worse than letting the upstream be the judge.
  assert.equal(tokenExpiryMs("not-a-jwt"), undefined);
  assert.equal(tokenExpiryMs(""), undefined);
  assert.equal(tokenExpiryMs("a.notbase64!.c"), undefined);
});

test("an expired session is withheld rather than spent on a certain 401", () => {
  const seconds = Math.floor(Date.now() / 1000);
  // No Codex to run, so the refresh nudge is a no-op and the behaviour under
  // test is the withholding itself.
  process.env.CODEX_BIN = "/nonexistent/codex";
  try {
    process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK = "1";
    writeAuth({ access_token: jwtWithExp(seconds - 3600), account_id: ACCOUNT });
    assert.equal(nativeSessionHeaders(), undefined, "a dead token must not be sent");
    assert.equal(nativeSessionStatus().expired, true);
    assert.equal(nativeSessionStatus().usable, false);

    // Inside the skew: still refused, because a token that dies mid-flight
    // costs the whole turn.
    writeAuth({ access_token: jwtWithExp(seconds + 30), account_id: ACCOUNT });
    assert.equal(nativeSessionHeaders(), undefined);

    writeAuth({ access_token: jwtWithExp(seconds + 172800), account_id: ACCOUNT });
    assert.notEqual(nativeSessionHeaders(), undefined, "a live token must still be sent");
    assert.equal(nativeSessionStatus().usable, true);
    assert.ok(nativeSessionStatus().expiresInHours > 47);
  } finally {
    delete process.env.CODEX_BIN;
    delete process.env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK;
  }
});

test("status reports the remaining life, never the token", () => {
  const seconds = Math.floor(Date.now() / 1000);
  writeAuth({ access_token: jwtWithExp(seconds + 36000), account_id: ACCOUNT });
  writeConsentFixture();
  const status = nativeSessionStatus();
  assert.ok(status.expiresInHours > 9 && status.expiresInHours <= 10);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(ACCOUNT));
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});
