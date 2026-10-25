/**
 * Tests for the Recon Engine sign-in (services/recon-auth.js), DocLink's second login
 * after IREPS: password sign-in, who-am-I, sign-out and the Okta extension flow, with a
 * fake fetch and a fake chrome.identity. No extension APIs are used. Invoked from
 * run-tests.js.
 */

import {
  reconSignIn, reconWhoAmI, reconSignOut, reconProviders, reconOktaSignIn, oktaRedirectUri, isConfiguredOktaUrl,
  confirmReconSignIn, ReconAuthError, RECON_AUTH_ERROR
} from "../services/recon-auth.js";
import { applyReconConfig, RECON_CONFIG } from "../services/recon-service.js";
import { describeError } from "../utils/messages.js";
import { redact } from "../utils/logger.js";

const BASE = "http://localhost:8000";
const HOSTS = ["http://localhost:8765/*", "https://www.ireps.gov.in/*", "http://localhost:8000/*"];
const ISSUER = "https://wabtec.oktapreview.com/oauth2/default";
const CLIENT_ID = "0oa2uq0thn3v0mHWG0h8";
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${EXT_ID}.chromiumapp.org/okta`;
const AUTHORIZE = `${ISSUER}/v1/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st-1`;
// /api/auth/me as the Recon Engine answers it (roles: a list, with their permissions)
const USER = { id: 7, email: "alok@example.com", name: "Alok", roles: ["tendering"], permissions: ["ingest.ireps", "read", "reconcile.run"] };
const PARSED = { id: 7, email: "alok@example.com", name: "Alok", roles: ["tendering"], role: "tendering", isAdmin: false };
const CONFIG = { reconBaseUrl: BASE, okta: { enabled: true, issuer: ISSUER, clientId: CLIENT_ID, redirectPath: "okta" } };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

/** chrome.identity stand-in: answers launchWebAuthFlow with `redirect`, or throws `fail`. */
function fakeIdentity({ redirect = `${REDIRECT}?code=c-1&state=st-1`, fail = "" } = {}) {
  const calls = [];
  return {
    calls,
    getRedirectURL: (path) => `https://${EXT_ID}.chromiumapp.org/${path || ""}`,
    launchWebAuthFlow(options, callback) {
      calls.push(options);
      if (fail) throw new Error(fail);
      setTimeout(() => callback(redirect), 0);
    }
  };
}

/** The backend's Okta extension routes plus /me. */
function oktaBackend({ start = () => jsonResponse(200, { authorize_url: AUTHORIZE }), finish = () => jsonResponse(200, USER) } = {}) {
  return fakeFetch((url) => {
    if (url.includes("/okta/extension/start")) return start(url);
    if (url.includes("/okta/extension/finish")) return finish(url);
    return jsonResponse(404, {});
  });
}

export async function runReconAuthTests({ test, assert, eq }) {
  async function rejectsAuth(promise, code, message) {
    try {
      await promise;
    } catch (error) {
      assert(error instanceof ReconAuthError, `${message || "expected ReconAuthError"}: got ${error && error.stack}`);
      eq(error.code, code, message || "error code");
      return error;
    }
    throw new Error(`${message || "expected rejection"}: promise resolved`);
  }

  await test("Recon sign-in: POST /api/auth/login as JSON with the cookie jar; the user comes back", async () => {
    applyReconConfig(CONFIG);
    const fetch = fakeFetch(() => jsonResponse(200, USER));
    const user = await reconSignIn(" alok@example.com ", "s3cret pass", { fetch, hostPermissions: HOSTS });
    eq(fetch.calls.length, 1);
    const { url, init } = fetch.calls[0];
    eq(url, `${BASE}/api/auth/login`);
    eq(init.method, "POST");
    eq(init.credentials, "include", "the session cookie lands in Chrome's jar");
    eq(init.headers["Content-Type"], "application/json");
    eq(init.body, JSON.stringify({ email: "alok@example.com", password: "s3cret pass" }));
    eq(JSON.stringify(user), JSON.stringify(PARSED));
  });

  await test("Recon sign-in: the user's roles list, admin among them; a single role from an older backend still reads", async () => {
    applyReconConfig(CONFIG);
    const admin = await reconWhoAmI({ fetch: fakeFetch(() => jsonResponse(200, { ...USER, roles: ["admin", "finance"] })), hostPermissions: HOSTS });
    eq(JSON.stringify(admin.user.roles), JSON.stringify(["admin", "finance"]));
    eq(admin.user.role, "admin, finance");
    eq(admin.user.isAdmin, true);
    const older = await reconWhoAmI({ fetch: fakeFetch(() => jsonResponse(200, { id: 1, email: "a@x.com", name: "A", role: "admin" })), hostPermissions: HOSTS });
    eq(JSON.stringify(older.user.roles), JSON.stringify(["admin"]));
    eq(older.user.isAdmin, true);
    const none = await reconWhoAmI({ fetch: fakeFetch(() => jsonResponse(200, { id: 2, email: "b@x.com", name: "B" })), hostPermissions: HOSTS });
    eq(none.user.roles.length, 0);
    eq(none.user.isAdmin, false);
  });

  await test("Recon sign-in: 401 / 422 / 403 / 429 / 5xx / network each map to a code with catalog text", async () => {
    applyReconConfig(CONFIG);
    const cases = [
      [401, { detail: { error: "INVALID_CREDENTIALS", detail: "x" } }, RECON_AUTH_ERROR.INVALID],
      [422, { detail: [] }, RECON_AUTH_ERROR.INVALID],
      [403, { detail: { error: "NO_ACCESS", detail: "Please contact Admin for access." } }, RECON_AUTH_ERROR.NO_ACCESS],
      [429, { detail: { error: "TOO_MANY_ATTEMPTS", detail: "wait" } }, RECON_AUTH_ERROR.LOCKED],
      [500, { detail: "boom" }, RECON_AUTH_ERROR.UNAVAILABLE]
    ];
    for (const [status, body, code] of cases) {
      await rejectsAuth(reconSignIn("a@b.c", "p", { fetch: fakeFetch(() => jsonResponse(status, body)), hostPermissions: HOSTS }), code, `HTTP ${status}`);
    }
    await rejectsAuth(reconSignIn("a@b.c", "p", { fetch: async () => { throw new TypeError("Failed to fetch"); }, hostPermissions: HOSTS }), RECON_AUTH_ERROR.UNAVAILABLE, "network");
    for (const code of Object.values(RECON_AUTH_ERROR)) {
      const described = describeError(code, { detail: "d" });
      eq(described.code, code, `${code} has catalog text`);
      eq(described.loginRequired, false, `${code} is not the IREPS login`);
    }
    assert(describeError(RECON_AUTH_ERROR.INVALID).message.includes("not the IREPS login"), "says which login");
  });

  await test("Recon sign-in: nothing is sent when reconBaseUrl is unset or outside host_permissions", async () => {
    const fetch = fakeFetch(() => jsonResponse(200, USER));
    applyReconConfig({});
    await rejectsAuth(reconSignIn("a@b.c", "p", { fetch, hostPermissions: HOSTS }), RECON_AUTH_ERROR.NOT_CONFIGURED);
    applyReconConfig({ reconBaseUrl: "https://recon.example.com" });
    await rejectsAuth(reconWhoAmI({ fetch, hostPermissions: HOSTS }), RECON_AUTH_ERROR.NOT_CONFIGURED);
    eq(fetch.calls.length, 0);
  });

  await test("Recon who-am-I / providers / sign-out", async () => {
    applyReconConfig(CONFIG);
    const me = await reconWhoAmI({ fetch: fakeFetch(() => jsonResponse(200, USER)), hostPermissions: HOSTS });
    eq(me.signedIn, true);
    eq(me.user.email, USER.email);
    const out = await reconWhoAmI({ fetch: fakeFetch(() => jsonResponse(401, { detail: { error: "NOT_AUTHENTICATED" } })), hostPermissions: HOSTS });
    eq(out.signedIn, false);
    const noRole = await reconWhoAmI({ fetch: fakeFetch(() => jsonResponse(403, { detail: { error: "NO_ACCESS" } })), hostPermissions: HOSTS });
    eq(noRole.reason, "NO_ACCESS");
    eq(JSON.stringify(await reconProviders({ fetch: fakeFetch(() => jsonResponse(200, { password: true, okta: true })), hostPermissions: HOSTS })), JSON.stringify({ password: true, okta: true }));
    const fetch = fakeFetch(() => jsonResponse(200, { status: "signed_out" }));
    await reconSignOut({ fetch, hostPermissions: HOSTS });
    eq(fetch.calls[0].url, `${BASE}/api/auth/logout`);
    eq(fetch.calls[0].init.method, "POST");
    eq(fetch.calls[0].init.credentials, "include");
  });

  await test("Okta config: read from config.json okta; no issuer/client id = off; never a secret", () => {
    applyReconConfig(CONFIG);
    eq(RECON_CONFIG.okta.enabled, true);
    eq(RECON_CONFIG.okta.issuer, ISSUER);
    eq(RECON_CONFIG.okta.redirectPath, "okta");
    eq(Object.keys(RECON_CONFIG.okta).sort().join(","), "clientId,enabled,issuer,redirectPath", "no secret field");
    applyReconConfig({ reconBaseUrl: BASE, okta: { issuer: ISSUER } });
    eq(RECON_CONFIG.okta.enabled, false, "no client id");
    applyReconConfig({ reconBaseUrl: BASE, okta: { ...CONFIG.okta, enabled: false } });
    eq(RECON_CONFIG.okta.enabled, false, "switched off");
    applyReconConfig(CONFIG);
    eq(oktaRedirectUri({ identity: fakeIdentity() }), REDIRECT);
  });

  await test("Okta sign-in: start with the extension redirect, open Okta, hand code + state to finish", async () => {
    applyReconConfig(CONFIG);
    const fetch = oktaBackend();
    const identity = fakeIdentity();
    const user = await reconOktaSignIn({ fetch, identity, hostPermissions: HOSTS });
    eq(user.email, USER.email);
    eq(fetch.calls[0].url, `${BASE}/api/auth/okta/extension/start?redirect_uri=${encodeURIComponent(REDIRECT)}`);
    eq(fetch.calls[0].init.credentials, "include", "state/nonce/PKCE ride the session cookie");
    eq(identity.calls.length, 1);
    eq(identity.calls[0].url, AUTHORIZE);
    eq(identity.calls[0].interactive, true);
    eq(fetch.calls[1].url, `${BASE}/api/auth/okta/extension/finish?code=c-1&state=st-1`);
    eq(fetch.calls[1].init.credentials, "include");
  });

  await test("Okta sign-in: an authorize URL of another Okta app or host is never opened", async () => {
    applyReconConfig(CONFIG);
    assert(isConfiguredOktaUrl(AUTHORIZE), "the configured app");
    const wrong = [
      AUTHORIZE.replace(CLIENT_ID, "0oaOTHER"),
      AUTHORIZE.replace("wabtec.oktapreview.com", "evil.example"),
      AUTHORIZE.replace("https:", "http:"),
      AUTHORIZE.replace("/oauth2/default/", "/oauth2/other/")
    ];
    for (const url of wrong) {
      assert(!isConfiguredOktaUrl(url), url);
      const identity = fakeIdentity();
      await rejectsAuth(reconOktaSignIn({ fetch: oktaBackend({ start: () => jsonResponse(200, { authorize_url: url }) }), identity, hostPermissions: HOSTS }), RECON_AUTH_ERROR.OKTA_FAILED, url);
      eq(identity.calls.length, 0, "Okta window not opened");
    }
  });

  await test("Okta sign-in: cancel, unregistered redirect, Okta errors and refusals map to codes", async () => {
    applyReconConfig(CONFIG);
    const run = (opts, backend) => reconOktaSignIn({ fetch: oktaBackend(backend), identity: fakeIdentity(opts), hostPermissions: HOSTS });
    await rejectsAuth(run({ fail: "The user did not approve access." }), RECON_AUTH_ERROR.OKTA_CANCELLED, "window closed");
    const notRegistered = await rejectsAuth(run({ fail: "Authorization page could not be loaded." }), RECON_AUTH_ERROR.OKTA_REDIRECT_NOT_REGISTERED, "Okta refused the redirect");
    eq(notRegistered.detail, REDIRECT, "the URI to register is named");
    assert(describeError(notRegistered.code, notRegistered).message.includes(REDIRECT), "message names the URI");
    await rejectsAuth(run({ redirect: `${REDIRECT}?error=invalid_request&error_description=The+%27redirect_uri%27+parameter+must+be+a+Login+redirect+URI` }), RECON_AUTH_ERROR.OKTA_REDIRECT_NOT_REGISTERED, "error=invalid_request redirect");
    await rejectsAuth(run({ redirect: `${REDIRECT}?error=access_denied&error_description=not+assigned` }), RECON_AUTH_ERROR.OKTA_NO_ACCESS, "not assigned to the app");
    await rejectsAuth(run({ redirect: `${REDIRECT}?state=st-1` }), RECON_AUTH_ERROR.OKTA_FAILED, "no code");
    await rejectsAuth(run({}, { start: () => jsonResponse(503, { detail: { error: "OKTA_NOT_CONFIGURED" } }) }), RECON_AUTH_ERROR.OKTA_NOT_CONFIGURED, "backend without Okta");
    await rejectsAuth(run({}, { start: () => jsonResponse(400, { detail: { error: "INVALID_REDIRECT" } }) }), RECON_AUTH_ERROR.OKTA_REDIRECT_NOT_REGISTERED, "backend allow-list");
    await rejectsAuth(run({}, { finish: () => jsonResponse(403, { detail: { error: "NO_ACCESS", detail: "x" } }) }), RECON_AUTH_ERROR.OKTA_NO_ACCESS);
    await rejectsAuth(run({}, { finish: () => jsonResponse(401, { detail: { error: "INACTIVE", detail: "x" } }) }), RECON_AUTH_ERROR.OKTA_INACTIVE);
    await rejectsAuth(run({}, { finish: () => jsonResponse(401, { detail: { error: "FAILED", detail: "x" } }) }), RECON_AUTH_ERROR.OKTA_FAILED);
    applyReconConfig({ reconBaseUrl: BASE });
    const fetch = oktaBackend();
    await rejectsAuth(reconOktaSignIn({ fetch, identity: fakeIdentity(), hostPermissions: HOSTS }), RECON_AUTH_ERROR.OKTA_NOT_CONFIGURED, "no okta in config.json");
    eq(fetch.calls.length, 0);
  });

  await test("Recon sign-in: the password is never logged, and the panel event resolves without a sign-in page", async () => {
    eq(redact({ email: "a@b.c", password: "s3cret" }).password, "[REDACTED]");
    eq(await confirmReconSignIn(), true, "no listener: the upload itself reports a missing sign-in");
  });
}
