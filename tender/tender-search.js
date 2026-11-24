// Tender search: drives the real IREPS "Search Tender" form and returns the EXACT tender row.
// Form fields, hidden fields and tokens are read from the live form on every attempt; only the
// search term, department and date window are chosen here.

import {
  TenderError, log, norm,
  irepsFetch, assertSession, parseHtml, formParams, findForm, elementActions, qparam,
} from './tender-core.js';
import { describeError } from '../utils/messages.js';
import { withIrepsFormLock } from '../services/ireps-form-lock.js';

export const SEARCH_PATH = '/epsn/search/advancedSearch.do';

const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');

/** Format a Date in the same style as `sample` (dd/mm/yyyy by default). */
export function fmtDate(d, sample = '') {
  const [dd, mm, yyyy] = [pad2(d.getDate()), pad2(d.getMonth() + 1), d.getFullYear()];
  if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return `${yyyy}-${mm}-${dd}`;
  const sep = /^\d{2}([-.])\d{2}\1\d{4}$/.exec(sample)?.[1] || '/';
  return [dd, mm, yyyy].join(sep);
}

/**
 * Search windows relative to today. IREPS limits a range to six months, so each window spans
 * 180 days. Order: around today first (most tenders), then further future, then further past.
 */
export function dateWindows(today = new Date()) {
  const offs = [[-90, 90], [90, 270], [-270, -90], [270, 450], [-450, -270], [-630, -450]];
  return offs.map(([a, b]) => ({ from: new Date(today.getTime() + a * DAY), to: new Date(today.getTime() + b * DAY), label: `${a}d..${b}d` }));
}

export const tenderEquals = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

/** Rows whose tender-number cell is EXACTLY the requested number (whitespace-normalised). */
export function findTenderRows(doc, tenderNo) {
  return [...doc.querySelectorAll('tr')].filter(
    (tr) =>
      !tr.querySelector('tr') &&
      [...tr.querySelectorAll('td,th,a,span,b,strong,font,div')].some((c) => tenderEquals(c.textContent, tenderNo)),
  );
}

/** Token-bounded match (used only when no exact-cell row exists): "ABC-1" never matches "ABC-12". */
export function findTenderRowsLoose(doc, tenderNo) {
  const esc = norm(tenderNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9\\-/_])${esc}($|[^A-Za-z0-9\\-/_])`, 'i');
  return [...doc.querySelectorAll('tr')].filter(
    (tr) => !tr.querySelector('tr') && [...tr.children].some((c) => /^t[dh]$/i.test(c.tagName) && re.test(norm(c.textContent))),
  );
}

/** Column-aware description of a result row ("Deptt./Rly. Unit | Tender No | Title | Status | ..."). */
export function describeRow(tr) {
  const cells = [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName)).map((c) => norm(c.textContent));
  const out = { tenderTitle: '', department: '', railwayUnit: '', tenderStatus: '', closingDate: '' };
  const table = tr.closest('table');
  const head = table && [...table.querySelectorAll('tr')].find((r) => r !== tr && /tender\s*no/i.test(norm(r.textContent)) && !r.querySelector('a'));
  if (head) {
    const heads = [...head.children].map((c) => norm(c.textContent).toLowerCase());
    heads.forEach((h, i) => {
      const v = cells[i] || '';
      if (/dept|rly|unit/.test(h) && !out.department) {
        const [d, ...r] = v.split('/');
        out.department = norm(d);
        out.railwayUnit = norm(r.join('/'));
      } else if (/title/.test(h)) out.tenderTitle = v;
      else if (/^status/.test(h)) out.tenderStatus = v;
      else if (/due date|closing/.test(h)) out.closingDate = v;
    });
  }
  return out;
}

/** The railway of a "Dept/Rly. Unit" value, its last "/" part: "DAHOD / WESTERN RLY" and "LOWER PAREL/WESTERN RLY" -> "WESTERN RLY". */
export function railwayOf(unit) {
  const parts = String(unit || '').split('/');
  return norm(parts[parts.length - 1]).toUpperCase();
}

/** "28/10/2026 11:00" -> "2026-10-28"; '' when it holds no dd/mm/yyyy date. */
const dmyDay = (text) => {
  const m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(String(text || ''));
  return m ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : '';
};

const localDay = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : '');

/**
 * How well a result row fits what the caller knows: 2 when it is of the `railway` hinted, plus 1 when it closes on
 * the day of the `dueDate` hinted. The railway weighs more, as in preferredRows: a row of the right railway beats
 * one that only closes on the right day.
 */
function hintScore(row, { railway = '', dueDate = null } = {}) {
  const wantRailway = railwayOf(railway);
  const wantDay = localDay(dueDate);
  return (wantRailway && railwayOf(`${row.info.department}/${row.info.railwayUnit}`) === wantRailway ? 2 : 0)
    + (wantDay && dmyDay(row.info.closingDate) === wantDay ? 1 : 0);
}

/** The score of a row that fits every hint given (0 without hints). */
const fullScore = ({ railway = '', dueDate = null } = {}) => (railwayOf(railway) ? 2 : 0) + (localDay(dueDate) ? 1 : 0);

/**
 * Of several result rows with the same tender number (railways reuse numbers: 10263703 is a N F RLY and an
 * EAST CENTRAL RLY tender), the ones that fit what the caller knows: `railway`, a letter list's "Dept/Rly. Unit",
 * and `dueDate`, the NIT message's due date (a Date); the railway first, then the due date among the rows of that
 * railway (hintScore). A hint that no row fits is ignored, so the choice is then the one made without hints (the
 * row with the most actions).
 *   rows: [{ tr, actions, info: describeRow(tr) }]
 */
export function preferredRows(rows, prefer = {}) {
  const top = Math.max(...rows.map((r) => hintScore(r, prefer)));
  return rows.filter((r) => hintScore(r, prefer) === top);
}

/**
 * The row searchTender returns, of the rows with the tender number from every date window searched (`win`: the
 * window's place in the search order): the best fit to the hints (preferredRows), then the earliest window, then
 * the most actions. Without hints, or with hints no row fits, that is the first window's row with the most actions,
 * as before the hints were read across windows.
 */
function bestRow(rows, prefer) {
  const pool = preferredRows(rows, prefer);
  const first = Math.min(...pool.map((r) => r.win));
  return pool.filter((r) => r.win === first).sort((a, b) => b.actions.length - a.actions.length)[0];
}

/** Whether date window `win` holds day `day` ("2026-11-24"): the search is by closing date, so only then can it list a row closing that day. */
const holdsDay = (win, day) => Boolean(day) && localDay(win.from) <= day && day <= localDay(win.to);

/** Parse the live search form: action, defaults, input length limit and department choices. */
export function readSearchForm(doc) {
  const form = findForm(doc, (f) => f.querySelector('[name=advancedSearch]'));
  if (!form) return null;
  const maxLen = parseInt(form.querySelector('[name=advancedSearch]')?.getAttribute('maxlength') || '0', 10) || 0;
  const divisions = [...(form.querySelectorAll('select[name=division] option') || [])].map((o) => ({ value: o.value, label: norm(o.textContent) }));
  return {
    form,
    action: form.getAttribute('action') || SEARCH_PATH,
    defaults: formParams(form),
    maxLen,
    divisions,
    hasToken: [...form.elements].some((e) => /token/i.test(e.getAttribute('name') || '')),
  };
}

/**
 * What a Search Tender page says beyond what every Search Tender page carries. The form page and the results page
 * (corrigendum response.har, both captured) hold the department list's "Please Select Department", the hidden note
 * "*Date range should be within 6 months." (#dateRangeDiv, which the page's script shows for a custom date range),
 * the note "Note:- Please enter minimum first 3 characters of Tender Number ..." and the script's alerts: none of
 * them is IREPS's answer to a search, so they are left out here.
 */
function pageMessageText(doc) {
  const body = doc.body?.cloneNode(true);
  if (!body) return '';
  const ownText = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
  for (const el of [...body.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'select', 'option', 'optgroup', 'datalist'].includes(tag)
      || /display\s*:\s*none/i.test(el.getAttribute('style') || '') || /^dateRangeDiv$/i.test(el.id || '')
      || /^note\s*:/i.test(ownText(el))) el.remove();
  }
  return norm(body.textContent);
}

/**
 * 'results' | 'none' | 'invalid' | 'other'. 'invalid' only when the page itself says the search was refused (a
 * department is required, a date range too long): the form's own notes and choices never count (pageMessageText).
 * Any other page is 'other': the search was not answered, never "not found".
 */
export function classifySearchResponse(doc) {
  const text = norm(doc.body?.textContent);
  if (/tender\s*no/i.test(text) && [...doc.querySelectorAll('tr')].some((tr) => !tr.querySelector('tr') && tr.querySelector('a') && /View Tender Document|nitPublish/i.test(tr.innerHTML))) return 'results';
  if (/no results found/i.test(text)) return 'none';
  if (/select department|date range should|within 6 months|please (enter|select)/i.test(pageMessageText(doc))) return 'invalid';
  return 'other';
}

/** The fields of a search, in the order the browser sends them (Search Tender, 20 Nov 2026 capture). */
const BROWSER_FIELD_ORDER = Object.freeze(['searchOption', 'searchOptorOption', 'advancedSearch', 'organization', 'workArea', 'changezone', 'railwayZone',
  'division', 'unit', 'tenderStage', 'tenderType', 'bidding', 'selectDate', 'dateFrom', 'dateTo', 'direction', 'noMonthDay', 'monthDay', 'radioDuration', 'submit', 'searchParam']);

/**
 * The search for the tenders CLOSING on `day`, as the browser sends it in the 20 Nov 2026 capture: Tender Number
 * search with the number left empty (or `tenderNo`), "Tender Closing Date" (TENDER_OPENING_DATE) from `day` to
 * `day`, Custom Date, the Stores department (all departments only if the form has no Stores), and every other
 * field at the live form's own value. The fields keep the browser's order: the page script fills
 * searchOptorOption and the pressed button goes as submit=Show Results, so neither is where the form's own
 * serialisation puts it. A field the live form has beyond the capture follows them, in the form's order.
 * @param {{ defaults: URLSearchParams, maxLen: number, divisions: { value: string }[] }} formInfo  readSearchForm
 * @param {Date} day
 * @param {{ tenderNo?: string }} [opts]
 * @returns {URLSearchParams}
 */
export function closingDaySearchBody(formInfo, day, { tenderNo = '' } = {}) {
  const { defaults } = formInfo;
  const sample = defaults.get('dateFrom') || defaults.get('dateTo') || '';
  const no = norm(tenderNo);
  const chosen = {
    searchOption: '1', // Tender Number, as captured also when no number is given
    searchOptorOption: '0', // Starting with
    advancedSearch: formInfo.maxLen && no.length > formInfo.maxLen ? no.slice(0, formInfo.maxLen) : no,
    division: formInfo.divisions.some((d) => d.value === '19') ? '19' : '-1', // Stores, as captured
    dateFrom: fmtDate(day, sample),
    dateTo: fmtDate(day, sample),
    radioDuration: '0', // Custom Date
    submit: 'Show Results',
  };
  const ifEmpty = { railwayZone: '-1', unit: '-1', tenderStage: '-1', tenderType: '-1', bidding: '-1', selectDate: 'TENDER_OPENING_DATE' };
  const body = new URLSearchParams();
  for (const k of BROWSER_FIELD_ORDER) body.append(k, k in chosen ? chosen[k] : defaults.get(k) || ifEmpty[k] || '');
  for (const [k, v] of defaults) if (!BROWSER_FIELD_ORDER.includes(k)) body.append(k, v);
  return body;
}

/** IREPS's own count on a Search Tender result page ("Tender search results 1214"), or null when it shows none. */
export function searchResultsTotal(doc) {
  const m = /Tender\s+search\s+results\s*(\d+)/i.exec(norm(doc.body?.textContent));
  return m ? Number(m[1]) : null;
}

/**
 * The result page links this page shows, by page number: hrefs to advancedSearch.do with count= and pageNo=, the
 * first one of each number. IREPS shows the ten page links around this page and "next" to the first of the next ten
 * (20 Nov 2026 capture: page 2 shows 1-10 and next = 11).
 */
export function resultPageLinks(doc) {
  const links = new Map();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const n = Number(qparam(href, 'pageNo'));
    if (/advancedSearch\.do/i.test(href) && n > 0 && !links.has(n)) links.set(n, href);
  }
  return links;
}

/**
 * The link to result page `pageNo + 1` as this page shows it, or '' on the last page. It is followed as given, as
 * the browser would: IREPS keeps the rest of the search in the session, and its links are not all alike (page 2's
 * say railwayzone= where page 1's say railwayzone=-1).
 */
export function nextResultPage(doc, pageNo) {
  return resultPageLinks(doc).get(pageNo + 1) || '';
}

/**
 * The link to result page `n` from this page: the one IREPS shows, else one of its page links with only the page
 * number changed (IREPS shows ten page links at a time), or '' when the page shows no page link at all.
 */
export function resultPageLink(doc, n) {
  const links = resultPageLinks(doc);
  const first = links.values().next().value;
  return links.get(n) || (first ? first.replace(/([?&]pageNo=)\d+/i, `$1${n}`) : '');
}

/** Open the live Search Tender form (POST searchParam=showPage, as IREPS does; else a GET): readSearchForm + pageUrl. */
export async function loadForm(base) {
  // IREPS opens the form with POST searchParam=showPage; fall back to a plain GET.
  for (const method of ['POST', 'GET']) {
    const res = await irepsFetch(base, SEARCH_PATH, method === 'POST' ? { method, form: { searchParam: 'showPage' } } : {});
    assertSession(res);
    if (res.status !== 200) continue;
    const info = readSearchForm(parseHtml(res.text()));
    if (info) return { ...info, pageUrl: res.url };
  }
  throw new TenderError('SEARCH_FORM', 'Could not open the IREPS Search Tender form.');
}

function departmentOrder(divisions) {
  const vals = divisions.map((d) => d.value).filter((v) => v && v !== '-1');
  const first = [];
  if (vals.includes('19')) first.push('19'); // Stores - what the IREPS walkthrough uses
  first.push('-1');
  return { first, rest: vals.filter((v) => v !== '19') };
}

/**
 * Find the exact tender. Retries across valid (<= 6 month) date windows, and across departments
 * only if IREPS refuses "all departments".
 * -> { tenderNo, tenderTitle, department, railwayUnit, tenderStatus, closingDate, searchUrl, row, searchTerm, truncated }
 * NOT_FOUND only when IREPS answered every search (results without the tender, or "No Results Found"); when
 * a search got an HTTP error or a page DocLink does not recognise, the tender may exist: SEARCH_INCOMPLETE (H4).
 *   prefer: { railway, dueDate } picks among rows with the same number, across the date windows (preferredRows,
 *   bestRow); it adds no request when the first window with the number has a row that fits it (see below)
 * IREPS keeps one search (and one Struts token) per session, so the form load and each search with the reading of
 * its answer run under the IREPS form lock, released between searches for DocLink's other form sequences (M2).
 * The caller must not hold the lock (it is not re-entrant): closingDateFor, openTender and the tender run do not.
 */
export async function searchTender(base, rawTenderNo, { today = new Date(), onProgress = () => {}, preferWindows = [], prefer = {} } = {}) {
  const tenderNo = norm(rawTenderNo);
  log('Tender', 'Searching tender number');
  let formInfo = await withIrepsFormLock(() => loadForm(base));
  const maxLen = formInfo.maxLen;
  const truncated = !!maxLen && tenderNo.length > maxLen;
  const searchTerm = truncated ? tenderNo.slice(0, maxLen) : tenderNo;
  if (truncated) log('Tender', `Tender number is longer than the form limit (${maxLen}); searching by prefix, exact match is still required`);

  // preferWindows: [[fromDays, toDays], ...] relative to today, tried before the standard order
  const windows = [
    ...preferWindows.map(([a, b]) => ({ from: new Date(today.getTime() + a * DAY), to: new Date(today.getTime() + b * DAY), label: `${a}d..${b}d` })),
    ...dateWindows(today),
  ];
  const { first, rest } = departmentOrder(formInfo.divisions);
  let allDeptsRejected = false;
  let attempts = 0;
  const unanswered = []; // searches IREPS did not answer with a page DocLink recognises

  /** One search of window `win` (its place in `windows`: `place`): the rows with the number, or null. */
  const attempt = (win, dept, place) => withIrepsFormLock(async () => {
    attempts++;
    if (formInfo.hasToken) formInfo = await loadForm(base); // fresh Struts token for each submit
    const p = new URLSearchParams(formInfo.defaults);
    const sample = p.get('dateFrom') || p.get('dateTo') || '';
    p.set('searchOption', '1'); // Tender Number
    p.set('searchOptorOption', '0'); // Starting with
    p.set('advancedSearch', searchTerm);
    p.set('division', dept);
    if (!p.get('railwayZone')) p.set('railwayZone', '-1');
    for (const k of ['unit', 'tenderStage', 'tenderType', 'bidding']) if (!p.get(k)) p.set(k, '-1');
    if (!p.get('selectDate')) p.set('selectDate', 'TENDER_OPENING_DATE');
    p.set('dateFrom', fmtDate(win.from, sample));
    p.set('dateTo', fmtDate(win.to, sample));
    p.set('radioDuration', '0'); // custom dates
    p.set('submit', 'Show Results');

    const res = await irepsFetch(base, formInfo.action, { method: 'POST', form: p, relativeTo: formInfo.pageUrl });
    assertSession(res);
    if (res.status !== 200) {
      unanswered.push(`HTTP ${res.status}`);
      log('Tender', `window ${win.label} dept ${dept}: HTTP ${res.status}`, 'warn');
      return null;
    }
    const doc = parseHtml(res.text());
    const kind = classifySearchResponse(doc);
    if (kind === 'invalid' && dept === '-1') allDeptsRejected = true;
    if (kind === 'other') unanswered.push(`a page DocLink does not recognise ("${norm(doc.title) || norm(doc.body?.textContent).slice(0, 40)}")`);
    if (kind !== 'results') {
      log('Tender', `window ${win.label} dept ${dept}: ${kind}`);
      return null;
    }
    const rows = findTenderRows(doc, tenderNo);
    log('Tender', `window ${win.label} dept ${dept}: ${rows.length} exact match(es)`);
    if (!rows.length) return null;
    return rows.map((tr) => ({ tr, actions: elementActions(tr), info: describeRow(tr), searchUrl: res.url, win: place }));
  });

  /** The tender found: the row bestRow takes of the rows with the number, with what IREPS shows of it. */
  const chosen = (found) => {
    const best = bestRow(found, prefer);
    if (found.length > 1) {
      const where = (r) => `${r.info.department}/${r.info.railwayUnit} due ${r.info.closingDate}`;
      log('Tender', `${found.length} tenders numbered ${tenderNo} (${found.map(where).join('; ')}); took ${where(best)}`);
    }
    log('Tender', 'Exact tender found');
    return { ...best.info, tenderNo, searchUrl: best.searchUrl, row: { tr: best.tr, actions: best.actions }, searchTerm, truncated };
  };

  // Railways reuse tender numbers, so the hints (prefer) decide between the rows of every date window that has the
  // number, not only between those of the first one (6.5). They add no request when the first window with the number
  // already has a row that fits every hint given: that row is taken at once, as before. Only when it has none are the
  // later windows searched as well, and of those only the ones that can hold a row fitting better: a row of the hinted
  // railway can be in any window, a row closing on the hinted due day only in a window that holds that day (the
  // search is by closing date). A hint no row fits leaves the first window's row (bestRow).
  const found = [];
  const full = fullScore(prefer);
  const top = () => Math.max(...found.map((r) => hintScore(r, prefer)));
  const reach = (win) => (railwayOf(prefer.railway) ? 2 : 0) + (holdsDay(win, localDay(prefer.dueDate)) ? 1 : 0);
  for (const [i, win] of windows.entries()) {
    if (found.length && top() >= full) break;
    if (found.length && reach(win) <= top()) continue;
    if (found.length) log('Tender', `No row of ${tenderNo} found so far fits the railway / due date the caller knows; searching date range ${win.label} too`);
    onProgress(i === 0 ? 'Finding Tender...' : `Finding Tender (date range ${i + 1}/${windows.length})...`);
    for (const dept of first) {
      const rows = await attempt(win, dept, i);
      if (rows) {
        found.push(...rows);
        break;
      }
    }
  }
  if (found.length) return chosen(found);
  if (allDeptsRejected) {
    log('Tender', 'IREPS requires a department; trying each department');
    for (const win of windows.slice(0, 3)) {
      for (const dept of rest) {
        const rows = await attempt(win, dept, 0);
        if (rows) return chosen(rows);
      }
    }
  }
  if (unanswered.length) {
    log('Tender', `Tender not found, but ${unanswered.length} of ${attempts} searches got no answer`, 'warn');
    throw new TenderError('SEARCH_INCOMPLETE', describeError('TENDER_SEARCH_INCOMPLETE', {
      detail: `${tenderNo} was not in the ${attempts - unanswered.length} result page(s) IREPS returned, and ${unanswered.length} search(es) got ${[...new Set(unanswered)].slice(0, 2).join(', ')}`,
    }).message);
  }
  log('Tender', `Tender not found after ${attempts} search attempts`);
  throw new TenderError('NOT_FOUND', `Tender ${tenderNo} was not found in IREPS (checked ${windows.length} date ranges).`);
}
