/**
 * Recon Engine sign-in: DocLink's SECOND login.
 *
 *   1. IREPS     - the user's own portal login with the e-sign / security key, in the
 *                  IREPS tab. DocLink only detects it (popup-gate.js, session-service.js).
 *   2. Recon     - the joulestowatts password or Okta sign-in of the Recon Engine backend,
 *                  needed only for "Save to: ECM / S3" (POST /api/ecm/documents and
 *                  POST /api/documents are gated by it). This module.
 *
 * Both ways end in the backend's own httponly session cookie, which Chrome keeps in its
 * cookie jar and sends with every credentials: "include" request to reconBaseUrl:
 *
 *   password  POST {reconBaseUrl}/api/auth/login {email, password}
 *   Okta      GET  {reconBaseUrl}/api/auth/okta/extension/start?redirect_uri=<chromiumapp>
 *             -> chrome.identity.launchWebAuthFlow(authorize_url) -> ?code=&state=
 *             GET  {reconBaseUrl}/api/auth/okta/extension/finish?code=&state=
 *   who       GET  {reconBaseUrl}/api/auth/me
 *   sign out  POST {reconBaseUrl}/api/auth/logout
 *
 * The Okta client SECRET, state, nonce and PKCE verifier stay in the backend; DocLink
 * only carries the code back. DocLink opens an authorize URL only when it is the Okta
 * app config.json names (okta.issuer, okta.clientId). The redirect it registers is
 * https://<extension id>.chromiumapp.org/<okta.redirectPath>, which must also be a
 * sign-in redirect URI of that Okta app.
 *
 * Nothing here stores anything: no password, cookie or token is written, logged or read
 * back. A typed password goes once to the Recon Engine and is dropped.
 */

import { logger } from "../utils/logger.js";
import { RECON_CONFIG, loadReconConfig, reconConfigProblem, manifestHostPermissions, apiErrorDetail } from "./recon-service.js";

/** Error codes; each has an entry in utils/messages.js ERROR_CATALOG. */
export const RECON_AUTH_ERROR = Object.freeze({
  NOT_CONFIGURED: "RECON_NOT_CONFIGURED",
  UNAVAILABLE: "RECON_SIGNIN_UNAVAILABLE",
  INVALID: "RECON_SIGNIN_INVALID",
  NO_ACCESS: "RECON_SIGNIN_NO_ACCESS",
  LOCKED: "RECON_SIGNIN_LOCKED",
  OKTA_NOT_CONFIGURED: "OKTA_NOT_CONFIGURED",
  OKTA_CANCELLED: "OKTA_CANCELLED",
  OKTA_REDIRECT_NOT_REGISTERED: "OKTA_REDIRECT_NOT_REGISTERED",
  OKTA_FAILED: "OKTA_FAILED",
  OKTA_NO_ACCESS: "OKTA_NO_ACCESS",
  OKTA_INACTIVE: "OKTA_INACTIVE"
});

export class ReconAuthError extends Error {
  /**
   * @param {string} code     one of RECON_AUTH_ERROR
   * @param {{ status?: number|null, detail?: string }} [details]
   */
  constructor(code, details = {}) {
    super(details.detail || code);
    this.name = "ReconAuthError";
    this.code = code;
    this.status = details.status ?? null;
    this.detail = details.detail || "";
  }
}

const AUTH_TIMEOUT_MS = 30000;

/** Panel event: "make sure someone is signed in to the Recon Engine" (popup-recon-auth.js answers it). */
export const RECON_SIGN_IN_EVENT = "doclink:ensure-recon-sign-in";

/**
 * From panel code that cannot reach popup-recon-auth.js directly (the tender view is
 * bundled separately): resolves true when the user is signed in to the Recon Engine
 * or signs in now, false when they chose Local. True when no sign-in page answers
 * (no panel, or the tests), so the upload itself reports a missing sign-in.
 */
export function confirmReconSignIn() {
  if (typeof document === "undefined" || typeof CustomEvent === "undefined") return Promise.resolve(true);
  return new Promise((resolve) => {
    const event = new CustomEvent(RECON_SIGN_IN_EVENT, { detail: { resolve }, cancelable: true });
    if (document.dispatchEvent(event)) resolve(true);
  });
}

/**
 * @typedef {Object} ReconUser
 * @property {number} id
 * @property {string} email
 * @property {string} name
 * @property {string} role    admin | analyst | viewer
 */

function userFrom(body) {
  return { id: body.id, email: body.email || "", name: body.name || body.email || "", role: body.role || "" };
}

/** The Okta redirect DocLink uses, e.g. https://<id>.chromiumapp.org/okta ("" outside an extension). */
export function oktaRedirectUri(deps = {}) {
  const identity = deps.identity || (typeof chrome !== "undefined" ? chrome.identity : undefined);
  if (!identity || typeof identity.getRedirectURL !== "function") return "";
  return identity.getRedirectURL(RECON_CONFIG.okta.redirectPath);
}

/** One call to the Recon auth API -> { response, body }. Network failure / timeout -> RECON_UNAVAILABLE. */
async function call(path, init, deps) {
  await loadReconConfig();
  const baseUrl = RECON_CONFIG.baseUrl;
  const problem = reconConfigProblem(baseUrl, deps.hostPermissions || manifestHostPermissions(), path.split("?")[0]);
  if (problem) throw new ReconAuthError(RECON_AUTH_ERROR.NOT_CONFIGURED, { detail: problem });
  const fetchImpl = deps.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, { ...init, credentials: "include", signal: controller.signal });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    logger.warn("Recon Engine unreachable for sign-in", { path: path.split("?")[0], timedOut });
    throw new ReconAuthError(RECON_AUTH_ERROR.UNAVAILABLE, { detail: timedOut ? "no response within 30 seconds" : `could not reach ${new URL(baseUrl).origin}` });
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function errorCode(body) {
  const d = body && body.detail;
  return d && typeof d === "object" && typeof d.error === "string" ? d.error : "";
}

function unavailable(response, body) {
  return new ReconAuthError(RECON_AUTH_ERROR.UNAVAILABLE, { status: response.status, detail: apiErrorDetail(body) || `HTTP ${response.status}` });
}

/**
 * Who is signed in to the Recon Engine in this Chrome profile.
 * @returns {Promise<{ signedIn: true, user: ReconUser } | { signedIn: false, reason: string }>}
 */
export async function reconWhoAmI(deps = {}) {
  const { response, body } = await call("/api/auth/me", { method: "GET" }, deps);
  if (response.ok && body) return { signedIn: true, user: userFrom(body) };
  if (response.status === 401) return { signedIn: false, reason: "NOT_AUTHENTICATED" };
  if (response.status === 403) return { signedIn: false, reason: errorCode(body) || "NO_ACCESS" };
  throw unavailable(response, body);
}

/** What the backend offers: { password: true, okta: boolean }. */
export async function reconProviders(deps = {}) {
  const { response, body } = await call("/api/auth/providers", { method: "GET" }, deps);
  if (!response.ok || !body) throw unavailable(response, body);
  return { password: body.password !== false, okta: body.okta === true };
}

/**
 * Password sign-in (a Recon Engine user, e.g. made with scripts/create_user.py).
 * The password is sent once and not kept.
 * @returns {Promise<ReconUser>}
 */
export async function reconSignIn(email, password, deps = {}) {
  const { response, body } = await call(
    "/api/auth/login",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: String(email || "").trim(), password: String(password || "") }) },
    deps
  );
  if (response.ok && body) {
    logger.info("Signed in to the Recon Engine", { via: "password", role: body.role });
    return userFrom(body);
  }
  if (response.status === 401 || response.status === 422) throw new ReconAuthError(RECON_AUTH_ERROR.INVALID, { status: response.status });
  if (response.status === 403) throw new ReconAuthError(RECON_AUTH_ERROR.NO_ACCESS, { status: 403, detail: apiErrorDetail(body) });
  if (response.status === 429) throw new ReconAuthError(RECON_AUTH_ERROR.LOCKED, { status: 429 });
  throw unavailable(response, body);
}

/** Ends the Recon Engine session (the Okta session itself stays open, as in the web app). */
export async function reconSignOut(deps = {}) {
  const { response, body } = await call("/api/auth/logout", { method: "POST" }, deps);
  if (!response.ok) throw unavailable(response, body);
  logger.info("Signed out of the Recon Engine");
}

/** True when `url` is an authorize URL of the Okta app config.json names. */
export function isConfiguredOktaUrl(url, okta = RECON_CONFIG.okta) {
  let parsed;
  let issuer;
  try {
    parsed = new URL(url);
    issuer = new URL(okta.issuer);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.origin === issuer.origin && parsed.pathname.startsWith(`${issuer.pathname.replace(/\/+$/, "")}/`) && parsed.searchParams.get("client_id") === okta.clientId;
}

function launchWebAuthFlow(identity, url) {
  return new Promise((resolve, reject) => {
    try {
      const pending = identity.launchWebAuthFlow({ url, interactive: true }, (redirect) => {
        const lastError = typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.lastError : undefined;
        if (lastError) reject(new Error(lastError.message || "launchWebAuthFlow failed"));
        else resolve(redirect);
      });
      if (pending && typeof pending.then === "function") pending.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

const FINISH_ERROR = Object.freeze({
  NO_ACCESS: RECON_AUTH_ERROR.OKTA_NO_ACCESS,
  INACTIVE: RECON_AUTH_ERROR.OKTA_INACTIVE,
  OKTA_NOT_CONFIGURED: RECON_AUTH_ERROR.OKTA_NOT_CONFIGURED
});

/**
 * Okta sign-in through the extension redirect. Opens Okta's sign-in window.
 * @param {{ fetch?: typeof fetch, identity?: object, hostPermissions?: string[] }} [deps]
 * @returns {Promise<ReconUser>}
 */
export async function reconOktaSignIn(deps = {}) {
  await loadReconConfig();
  const okta = RECON_CONFIG.okta;
  if (!okta.enabled) throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_NOT_CONFIGURED, { detail: "okta.issuer / okta.clientId are not set in config.json" });
  const identity = deps.identity || (typeof chrome !== "undefined" ? chrome.identity : undefined);
  if (!identity || typeof identity.launchWebAuthFlow !== "function") throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_NOT_CONFIGURED, { detail: "the identity permission is missing" });
  const redirectUri = oktaRedirectUri({ identity });

  const start = await call(`/api/auth/okta/extension/start?redirect_uri=${encodeURIComponent(redirectUri)}`, { method: "GET" }, deps);
  if (start.response.status === 503) throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_NOT_CONFIGURED, { status: 503, detail: "Okta is not set up on the Recon Engine" });
  if (start.response.status === 400) throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_REDIRECT_NOT_REGISTERED, { status: 400, detail: redirectUri });
  if (!start.response.ok || !start.body || typeof start.body.authorize_url !== "string") throw unavailable(start.response, start.body);
  const authorizeUrl = start.body.authorize_url;
  if (!isConfiguredOktaUrl(authorizeUrl, okta)) {
    logger.warn("Refused an Okta sign-in URL that is not the configured Okta app");
    throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_FAILED, { detail: "the Recon Engine and config.json name different Okta apps" });
  }

  let redirect;
  try {
    redirect = await launchWebAuthFlow(identity, authorizeUrl);
  } catch (error) {
    const text = String((error && error.message) || error);
    // Chrome says "The user did not approve access." when the window is closed, and
    // "Authorization page could not be loaded." when Okta refuses the redirect URI.
    if (/did not approve|cancel|closed/i.test(text)) throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_CANCELLED);
    throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_REDIRECT_NOT_REGISTERED, { detail: redirectUri });
  }
  let params;
  try {
    params = new URL(redirect).searchParams;
  } catch {
    throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_FAILED, { detail: "Okta returned no answer" });
  }
  const oktaError = params.get("error");
  if (oktaError) {
    const description = params.get("error_description") || "";
    if (/redirect/i.test(description)) throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_REDIRECT_NOT_REGISTERED, { detail: redirectUri });
    if (oktaError === "access_denied") throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_NO_ACCESS, { detail: description });
    throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_FAILED, { detail: description || oktaError });
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) throw new ReconAuthError(RECON_AUTH_ERROR.OKTA_FAILED, { detail: "Okta returned no code" });

  const finish = await call(`/api/auth/okta/extension/finish?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { method: "GET" }, deps);
  if (finish.response.ok && finish.body) {
    logger.info("Signed in to the Recon Engine", { via: "okta", role: finish.body.role });
    return userFrom(finish.body);
  }
  if (finish.response.status === 401 || finish.response.status === 403 || finish.response.status === 503) {
    throw new ReconAuthError(FINISH_ERROR[errorCode(finish.body)] || RECON_AUTH_ERROR.OKTA_FAILED, { status: finish.response.status, detail: apiErrorDetail(finish.body) });
  }
  throw unavailable(finish.response, finish.body);
}
