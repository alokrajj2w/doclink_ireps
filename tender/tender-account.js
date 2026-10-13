// Active IREPS account detection.
// The identity is read from the authenticated home page (/epsn/home/showHome.do) on every call -
// nothing is hardcoded and nothing is cached across runs, so switching IREPS accounts is picked
// up the next time this is called. No cookie / token / credential is read or stored.

import { TenderError, SESSION_MSG, log, norm, getBaseUrl, irepsFetch, isLoginResponse, parseHtml } from './tender-core.js';

export const HOME_PATH = '/epsn/home/showHome.do';
export const ACCOUNT_UNVERIFIED_MSG = 'Unable to verify the active IREPS account. Please open IREPS, confirm your account and retry.';

// "A GIRIJA , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 833)"
const WELCOME_RE = /^(.*?)\s*,\s*(.+?)\s*\(\s*IREPS\s*ID\s*[-:]?\s*(\d+)\s*\)\s*$/i;

// The unit label is only taken when the company name itself spells it out:
// "<...legal suffix>-<UNIT>", e.g. "...PRIVATE LIMITED-HOSUR".
const UNIT_RE = /\b(?:LIMITED|LTD\.?|LLP|INC\.?|CORPORATION|CORP\.?|COMPANY|CO\.?)\s*-\s*([A-Z][A-Z0-9 .&]{1,40})$/i;

/** Pure parser for the welcome text. Returns null when it does not look like an account line. */
export function parseWelcomeText(text) {
  const m = WELCOME_RE.exec(norm(text));
  if (!m) return null;
  const companyName = norm(m[2]);
  const unit = UNIT_RE.exec(companyName)?.[1];
  return {
    userName: norm(m[1]),
    companyName,
    irepsAccountId: m[3],
    operatingUnit: unit ? norm(unit).toUpperCase() : null,
  };
}

/** Secondary evidence: account ids that the page's own scripts / links carry. */
export function secondaryAccountIds(html) {
  const ids = new Set();
  for (const re of [/reqMod\s*:\s*["']SwitchUser["']\s*,\s*accountId\s*:\s*['"](\d+)['"]/gi, /viewAccountAction\.do\?accountId=(\d+)/gi, /useracctName\s*=\s*['"](\d+)['"]/gi]) {
    for (const m of html.matchAll(re)) ids.add(m[1]);
  }
  return [...ids];
}

/** Parse an already-fetched home-page HTML document into an account context. */
export function accountFromHomeHtml(html) {
  const doc = parseHtml(html);
  const labels = [...doc.querySelectorAll('.welcomeLabel')].map((e) => norm(e.textContent)).filter(Boolean);
  let parsed = null;
  for (const t of labels) {
    parsed = parseWelcomeText(t);
    if (parsed) break;
  }
  const secondary = secondaryAccountIds(html);
  const loggedIn = !!parsed || /log\s*out|sign\s*out/i.test(norm(doc.body?.textContent).slice(0, 400000));

  const ctx = {
    irepsAccountId: parsed?.irepsAccountId || null,
    companyName: parsed?.companyName || null,
    operatingUnit: parsed?.operatingUnit || null,
    authenticated: loggedIn,
    verified: false,
    source: 'ireps_home_page',
    note: '',
  };
  if (!parsed) {
    ctx.note = 'The IREPS account line was not found on the home page.';
  } else if (secondary.length && !secondary.includes(parsed.irepsAccountId)) {
    ctx.note = 'The account id shown on the page disagrees with the id in the page scripts.';
  } else {
    ctx.verified = true;
  }
  return ctx;
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
