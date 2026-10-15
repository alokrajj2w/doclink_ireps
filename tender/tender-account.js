// Active IREPS account detection.
// The identity is read from the authenticated home page (/epsn/home/showHome.do) on every call -
// nothing is hardcoded and nothing is cached across runs, so switching IREPS accounts is picked
// up the next time this is called. No cookie / token / credential is read or stored.

import { TenderError, SESSION_MSG, log, getBaseUrl, irepsFetch, isLoginResponse, parseHtml } from './tender-core.js';
import { HOME_PATH, accountFromHomeDocument } from '../utils/ireps-account.js';

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
 * so the UI can say so. (Network failures still reject.)
 */
export async function getActiveIrepsAccountContext({ base } = {}) {
  log('Account', 'Checking active IREPS account');
  const b = base || (await getBaseUrl());
  const res = await irepsFetch(b, HOME_PATH);
  if (isLoginResponse(res) || res.status !== 200) {
    log('Account', `Not authenticated (HTTP ${res.status})`);
    return { irepsAccountId: null, companyName: null, operatingUnit: null, authenticated: false, verified: false, source: 'ireps_home_page', note: SESSION_MSG };
  }
  const ctx = accountFromHomeHtml(res.text());
  log('Account', ctx.verified ? `Account verified (id ${ctx.irepsAccountId}, unit ${ctx.operatingUnit || 'not stated'})` : `Account not verified: ${ctx.note}`);
  return ctx;
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
