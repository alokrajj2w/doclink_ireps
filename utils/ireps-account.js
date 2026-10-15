// The active IREPS account, read from the authenticated home page (/epsn/home/showHome.do).
// Pure: no fetch, no DOMParser. The side panel (tender/tender-account.js) and the offscreen
// document (for the service worker, which has no DOMParser) parse the page and hand the
// Document here, so both read the account the same way.

export const HOME_PATH = '/epsn/home/showHome.do';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// "A GIRIJA , FAIVELEY TRANSPORT RAIL TECHNOLOGIES INDIA PRIVATE LIMITED-HOSUR (IREPS ID- 833)"
const WELCOME_RE = /^(.*?)\s*,\s*(.+?)\s*\(\s*IREPS\s*ID\s*[-:]?\s*(\d+)\s*\)\s*$/i;

// The unit label is taken from a fixed account mapping when one exists, otherwise only when the
// company name itself spells it out: "<...legal suffix>-<UNIT>", e.g. "...PRIVATE LIMITED-HOSUR".
const UNIT_RE = /\b(?:LIMITED|LTD\.?|LLP|INC\.?|CORPORATION|CORP\.?|COMPANY|CO\.?)\s*-\s*([A-Z][A-Z0-9 .&]{1,40})$/i;

// IREPS account ids whose operating unit is fixed by the business (ECM spec, "ECM - Download speci-v1":
// vendor code 833 = Hosur - Brakes and Safety, 60828 = Rohtak - Brakes and Safety (BRH)).
// These win over the company-name suffix, and pick the unit's ECM folder.
export const ACCOUNT_UNITS = Object.freeze({
  '833': 'HOSUR',
  '60828': 'ROHTAK',
});

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
    operatingUnit: ACCOUNT_UNITS[m[3]] || (unit ? norm(unit).toUpperCase() : null),
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

/** An account context from the home page, already parsed into `doc` (its source is `html`). */
export function accountFromHomeDocument(doc, html) {
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
