/**
 * Which IREPS account is logged in, read by the service worker from the IREPS home page
 * (GET /epsn/home/showHome.do, the same request as before). It answers the scheduler's IREPS
 * check and gives a document run the ECM unit.
 *
 * Only IREPS's own login page means "not logged in". These are "IREPS not responding", never a
 * logout:
 *   - an HTTP error (502 / 503 / 504 are asked again twice first);
 *   - no answer in time, or no connection;
 *   - a page that is neither the login page nor a logged-in page (a busy / error page).
 * The scheduler tries again at its next check after one of those instead of waiting for the user
 * to log in.
 * The page is parsed by the caller (the offscreen document: the service worker has no DOMParser).
 */

import { fetchWithDeadline, DeadlineError } from "../utils/http.js";
import { HOME_PATH, isIrepsLoginHtml, asksForPassword } from "../utils/ireps-account.js";

/** Codes of a failed read (utils/messages.js). */
export const ACCOUNT_READ_ERROR = Object.freeze({
  SESSION_EXPIRED: "IREPS_SESSION_EXPIRED",
  UNAVAILABLE: "IREPS_UNAVAILABLE",
  UNVERIFIED: "SCHEDULE_ACCOUNT_UNVERIFIED",
  NOT_CONFIGURED: "IREPS_NOT_CONFIGURED"
});

/** IREPS answers these while it is overloaded: worth asking again. */
const BUSY_STATUSES = new Set([502, 503, 504]);

/** timeoutMs: one deadline per request (headers and body); retryDelaysMs: the waits before the 2nd, 3rd... try. */
export const ACCOUNT_READ_SETTINGS = Object.freeze({ timeoutMs: 45000, retryDelaysMs: [1000, 3000] });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   baseUrl: string,
 *   parse: (html: string) => Promise<{ authenticated: boolean, verified: boolean, irepsAccountId: string|null, operatingUnit: string|null, note: string }>,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   settings?: { timeoutMs: number, retryDelaysMs: number[] }
 * }} deps   parse: the home page -> utils/ireps-account.js accountFromHomeDocument's context
 * @returns {Promise<{ ok: true, account: { irepsAccountId: string, operatingUnit: string|null } } | { ok: false, code: string, detail: string }>}
 *   never rejects
 */
export async function readIrepsAccount({ baseUrl, parse, fetch, sleep = wait, settings = ACCOUNT_READ_SETTINGS }) {
  if (!baseUrl) return failed(ACCOUNT_READ_ERROR.NOT_CONFIGURED, "no IREPS portal in config.json");
  let answer;
  try {
    answer = await fetchHomePage(`${baseUrl}${HOME_PATH}`, { fetch, sleep, settings });
  } catch (error) {
    return failed(ACCOUNT_READ_ERROR.UNAVAILABLE, error instanceof DeadlineError ? `the home page did not answer: ${error.message}` : "IREPS could not be reached");
  }
  const { status, url, html } = answer;
  if (isIrepsLoginHtml(url, html)) return failed(ACCOUNT_READ_ERROR.SESSION_EXPIRED, "IREPS answered with its login page");
  if (status < 200 || status > 299) return failed(ACCOUNT_READ_ERROR.UNAVAILABLE, `the home page answered HTTP ${status}`);
  let ctx;
  try {
    ctx = await parse(html);
  } catch {
    return failed(ACCOUNT_READ_ERROR.UNVERIFIED, "the home page could not be read");
  }
  if (!ctx || !ctx.authenticated) {
    // no account line and no Log Out: a login form, or a busy / error page that says nothing about the login
    return asksForPassword(html)
      ? failed(ACCOUNT_READ_ERROR.SESSION_EXPIRED, "IREPS answered with a login form")
      : failed(ACCOUNT_READ_ERROR.UNAVAILABLE, "IREPS answered with a page that is not its home page");
  }
  if (!ctx.verified) return failed(ACCOUNT_READ_ERROR.UNVERIFIED, ctx.note || "the account line was not read");
  return { ok: true, account: { irepsAccountId: ctx.irepsAccountId, operatingUnit: ctx.operatingUnit } };
}

/** One GET of the home page, asked again on 502 / 503 / 504 or a failed connection (not after a timeout). */
async function fetchHomePage(url, { fetch, sleep, settings }) {
  for (let attempt = 0; ; attempt++) {
    const delay = settings.retryDelaysMs[attempt];
    try {
      const { response, body } = await fetchWithDeadline(url, { credentials: "include", redirect: "follow" }, { timeoutMs: settings.timeoutMs, fetch, read: "text" });
      if (!BUSY_STATUSES.has(response.status) || delay === undefined) return { status: response.status, url: response.url || url, html: body || "" };
    } catch (error) {
      if (error instanceof DeadlineError || delay === undefined) throw error;
    }
    await sleep(delay);
  }
}

function failed(code, detail) {
  return { ok: false, code, detail };
}
