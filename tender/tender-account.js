// Active IREPS account detection.
// The identity is read from the authenticated home page (/epsn/home/showHome.do) on every call -
// nothing is hardcoded and nothing is cached across runs, so switching IREPS accounts is picked
// up the next time this is called. No cookie / token / credential is read or stored.

import { TenderError, SESSION_MSG, log, getBaseUrl, irepsFetch, isLoginResponse, parseHtml, fetchSettings, STILL_OPENING } from './tender-core.js';
import { HOME_PATH, accountFromHomeDocument, asksForPassword } from '../utils/ireps-account.js';
import { ensureDownloadSignIn } from './tender-ecm.js';

// The parsing is shared with the service worker (MA / PO / IC uploads to the ECM need the unit too).
export { HOME_PATH, ACCOUNT_UNITS, parseWelcomeText, secondaryAccountIds } from '../utils/ireps-account.js';
export const ACCOUNT_UNVERIFIED_MSG = 'Unable to verify the active IREPS account. Please open IREPS, confirm your account and retry.';

/** Parse an already-fetched home-page HTML document into an account context. */
export function accountFromHomeHtml(html) {
  return accountFromHomeDocument(parseHtml(html), html);
}

/**
 * getActiveIrepsAccountContext()
 * Fetches the live IREPS home page with the user's existing browser session and returns:
 *   { irepsAccountId, companyName, operatingUnit, authenticated, verified, source }
 * Never throws for "not signed in" / "unreadable": it returns authenticated:false / verified:false
 * so the UI can say so. Only IREPS's login page is "not signed in". When IREPS does not answer with
 * its home page (HTTP 502/503/504 after two more tries, another HTTP error, a busy or error page) it
 * throws IREPS_UNAVAILABLE, and network failures throw TIMEOUT / UNREACHABLE: none of them is a logout.
 */
export async function getActiveIrepsAccountContext({ base } = {}) {
  log('Account', 'Checking active IREPS account');
  const b = base || (await getBaseUrl());
  const res = await fetchHomePage(b);
  if (isLoginResponse(res)) return notSignedIn(`the login page, HTTP ${res.status}`);
  if (res.status !== 200) throw irepsUnavailable(`its home page answered HTTP ${res.status}`);
  const html = res.text();
  const ctx = accountFromHomeHtml(html);
  if (!ctx.authenticated) {
    // no account line and no Log Out: a login form, or a busy / error page that says nothing about the login
    if (asksForPassword(html)) return notSignedIn('a login form');
    throw irepsUnavailable('it answered with a page that is not its home page');
  }
  log('Account', ctx.verified ? `Account verified (id ${ctx.irepsAccountId}, unit ${ctx.operatingUnit || 'not stated'})` : `Account not verified: ${ctx.note}`);
  return ctx;
}

/** The home page, asked again (after fetchSettings.netRetryMs) while IREPS answers 502 / 503 / 504. */
async function fetchHomePage(base) {
  for (let attempt = 0; ; attempt++) {
    const res = await irepsFetch(base, HOME_PATH);
    const delay = fetchSettings.netRetryMs[attempt];
    if (!STILL_OPENING.has(res.status) || delay === undefined) return res;
    log('Account', `IREPS answered HTTP ${res.status}; asking again in ${delay / 1000}s`, 'warn');
    await new Promise((r) => setTimeout(r, delay));
  }
}

function notSignedIn(what) {
  log('Account', `Not authenticated (${what})`);
  return { irepsAccountId: null, companyName: null, operatingUnit: null, authenticated: false, verified: false, source: 'ireps_home_page', note: SESSION_MSG };
}

function irepsUnavailable(why) {
  log('Account', `IREPS not responding: ${why}`, 'warn');
  return new TenderError('IREPS_UNAVAILABLE', `IREPS is not responding (${why}). This is not a logout: try again in a minute.`);
}

/** Folder label for downloads: the verified operating unit, else the account id. Never a guess. */
export function accountFolderLabel(account) {
  if (!account?.verified) throw new TenderError('ACCOUNT', ACCOUNT_UNVERIFIED_MSG);
  return account.operatingUnit || `IREPS_${account.irepsAccountId}`;
}

/** Throws unless the live account is still the one the run started with. */
export async function assertSameAccount(start, { base } = {}) {
  const now = await getActiveIrepsAccountContext({ base });
  if (!now.authenticated) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
  if (!now.verified || now.irepsAccountId !== start.irepsAccountId) {
    throw new TenderError('ACCOUNT_CHANGED', 'The active IREPS account changed during the download. Please confirm your account and retry.');
  }
  return now;
}

/**
 * The start of every tender / correspondence run: the Recon sign-in (every download is logged
 * for the signed-in user), the IREPS origin, and a live, verified IREPS account. An expired
 * session or an account that cannot be verified stops the run before anything is fetched.
 * @returns {Promise<{ base: string, account: object, folderLabel: string }>}
 */
export async function startTenderJob({ onProgress = () => {}, onAccount = () => {} } = {}) {
  await ensureDownloadSignIn();
  const base = await getBaseUrl();
  onProgress('Verifying IREPS account...');
  const account = await getActiveIrepsAccountContext({ base });
  onAccount(account);
  if (!account.authenticated) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
  if (!account.verified) throw new TenderError('ACCOUNT', ACCOUNT_UNVERIFIED_MSG);
  return { base, account, folderLabel: accountFolderLabel(account) };
}
