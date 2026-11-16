// Tender search: drives the real IREPS "Search Tender" form and returns the EXACT tender row.
// Form fields, hidden fields and tokens are read from the live form on every attempt; only the
// search term, department and date window are chosen here.

import {
  TenderError, log, norm,
  irepsFetch, assertSession, parseHtml, formParams, findForm, elementActions,
} from './tender-core.js';
import { describeError } from '../utils/messages.js';

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
 * Of several result rows with the same tender number (railways reuse numbers: 10263703 is a N F RLY and an
 * EAST CENTRAL RLY tender), the ones that fit what the caller knows: `railway`, a letter list's "Dept/Rly. Unit",
 * and `dueDate`, the NIT message's due date (a Date). A hint that no row fits is ignored, so the choice is then
 * the one made without hints (the row with the most actions).
 *   rows: [{ tr, actions, info: describeRow(tr) }]
 */
export function preferredRows(rows, { railway = '', dueDate = null } = {}) {
  const fits = (list, test) => {
    const kept = list.filter(test);
    return kept.length ? kept : list;
  };
  let pool = rows;
  const wantRailway = railwayOf(railway);
  if (wantRailway) pool = fits(pool, (r) => railwayOf(`${r.info.department}/${r.info.railwayUnit}`) === wantRailway);
  const wantDay = localDay(dueDate);
  if (wantDay) pool = fits(pool, (r) => dmyDay(r.info.closingDate) === wantDay);
  return pool;
}

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

/** 'results' | 'none' | 'invalid' | 'other' */
export function classifySearchResponse(doc) {
  const text = norm(doc.body?.textContent);
  if (/tender\s*no/i.test(text) && [...doc.querySelectorAll('tr')].some((tr) => !tr.querySelector('tr') && tr.querySelector('a') && /View Tender Document|nitPublish/i.test(tr.innerHTML))) return 'results';
  if (/no results found/i.test(text)) return 'none';
  if (/select department|date range should|within 6 months|please (enter|select)/i.test(text)) return 'invalid';
  return 'other';
}

async function loadForm(base) {
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
 *   prefer: { railway, dueDate } picks among rows with the same number (preferredRows); it adds no request
 */
export async function searchTender(base, rawTenderNo, { today = new Date(), onProgress = () => {}, preferWindows = [], prefer = {} } = {}) {
  const tenderNo = norm(rawTenderNo);
  log('Tender', 'Searching tender number');
  let formInfo = await loadForm(base);
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

  const attempt = async (win, dept) => {
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
    const described = rows.map((tr) => ({ tr, actions: elementActions(tr), info: describeRow(tr) }));
    const pool = described.length > 1 ? preferredRows(described, prefer) : described;
    const best = pool.sort((a, b) => b.actions.length - a.actions.length)[0];
    if (described.length > 1) {
      const where = (r) => `${r.info.department}/${r.info.railwayUnit} due ${r.info.closingDate}`;
      log('Tender', `${described.length} tenders numbered ${tenderNo} (${described.map(where).join('; ')}); took ${where(best)}`);
    }
    log('Tender', 'Exact tender found');
    return { ...best.info, tenderNo, searchUrl: res.url, row: { tr: best.tr, actions: best.actions }, searchTerm, truncated };
  };

  for (const [i, win] of windows.entries()) {
    onProgress(i === 0 ? 'Finding Tender...' : `Finding Tender (date range ${i + 1}/${windows.length})...`);
    for (const dept of first) {
      const hit = await attempt(win, dept);
      if (hit) return hit;
    }
  }
  if (allDeptsRejected) {
    log('Tender', 'IREPS requires a department; trying each department');
    for (const win of windows.slice(0, 3)) {
      for (const dept of rest) {
        const hit = await attempt(win, dept);
        if (hit) return hit;
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
