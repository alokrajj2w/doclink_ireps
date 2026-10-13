// My Messages > Inbox: discover tender numbers from IREPS's own messages.
//   list   POST /epsn/vendorInboxLink.do                     listType=MyMsg&pageNo=N   (pagination: menuexpand('MyMsg',N))
//   detail POST /epsn/admin/myMessages/ViewMessageDetailAction.do   oid=<message oid>
// Read-only: nothing is deleted, replied to or archived. (Opening a message does mark it "read" in IREPS,
// exactly as opening it by hand would.)

import { TenderError, log, norm, irepsFetch, assertSession, parseHtml, parseCalls, qparam } from './tender-core.js';

export const INBOX_PATH = '/epsn/vendorInboxLink.do';
export const MESSAGE_DETAIL_PATH = '/epsn/admin/myMessages/ViewMessageDetailAction.do';
const MAX_PAGES = 60;

const key = (dmy) => dmy.split('/').reverse().join(''); // dd/mm/yyyy -> yyyymmdd (sortable)
export const dmyOf = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

/** 'NIT' | 'CORRIGENDUM' | 'OTHER' - from the (full) subject. */
export function classifyMessage(subject) {
  const s = norm(subject);
  if (/^NIT for\b/i.test(s)) return 'NIT';
  if (/corrigendum/i.test(s)) return 'CORRIGENDUM';
  return 'OTHER';
}

/** One Inbox page -> rows + the page numbers its pagination links offer. */
export function parseInboxPage(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('tr')) {
    if (tr.querySelector('tr')) continue;
    const first = norm(tr.firstElementChild?.textContent);
    const m = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})/.exec(first);
    const oid = /ViewMessageDetailAction\.do\?oid=(\d+)/.exec(tr.innerHTML)?.[1];
    if (!m || !oid) continue;
    const link = tr.querySelector('a[title]');
    rows.push({
      oid,
      subject: norm(link?.getAttribute('title') || link?.textContent), // full subject lives in the title attribute
      sentDate: m[1],
      sentTime: m[2],
      sender: norm(tr.children[1]?.textContent),
      kind: classifyMessage(link?.getAttribute('title') || ''),
    });
  }
  const pages = new Set();
  for (const el of doc.querySelectorAll('[onclick]')) {
    for (const c of parseCalls(el.getAttribute('onclick'))) {
      if (/^menuexpand$/i.test(c.fn) && /^MyMsg$/i.test(c.args[0]) && /^\d+$/.test(c.args[1] || '')) pages.add(Number(c.args[1]));
    }
  }
  const total = Number(/Total Messages:\s*<\/strong>\s*(\d+)/i.exec(doc.body?.innerHTML || '')?.[1] || 0);
  return { rows, pages: [...pages].sort((a, b) => a - b), total };
}

/**
 * Walk the Inbox following its own pagination links (not assuming +1), newest first.
 * Messages dated within [from, to] (Date objects, inclusive) are returned; never the same message twice.
 * Stops following pages once a whole page is older than `from` (IREPS lists newest first).
 */
export async function scanMessages(base, { from, to, onProgress = () => {} }) {
  const lo = key(dmyOf(from));
  const hi = key(dmyOf(to));
  const visited = new Set();
  const queue = [1];
  const seen = new Set();
  const rows = [];
  let total = 0;
  let unreachable = false;
  while (queue.length && visited.size < MAX_PAGES) {
    const pageNo = queue.shift();
    if (visited.has(pageNo)) continue;
    visited.add(pageNo);
    onProgress(`Reading My Messages page ${pageNo}...`);
    const res = await irepsFetch(base, INBOX_PATH, { method: 'POST', form: { listType: 'MyMsg', pageNo: String(pageNo) } });
    assertSession(res);
    if (res.status !== 200) throw new TenderError('HTTP', `My Messages returned HTTP ${res.status}.`);
    const page = parseInboxPage(parseHtml(res.text()));
    total = total || page.total;
    log('Messages', `page ${pageNo}: ${page.rows.length} message(s), pagination links ${page.pages.join(',') || 'none'}`);
    for (const r of page.rows) {
      if (seen.has(r.oid)) continue;
      seen.add(r.oid);
      if (key(r.sentDate) >= lo && key(r.sentDate) <= hi) rows.push(r);
    }
    const allOlder = page.rows.length > 0 && page.rows.every((r) => key(r.sentDate) < lo);
    if (allOlder) { queue.length = 0; break; }
    for (const n of page.pages) if (!visited.has(n) && !queue.includes(n)) queue.push(n);
    queue.sort((a, b) => a - b);
    if (!page.rows.length) break;
  }
  if (queue.length) unreachable = true;
  return { rows, total, pagesRead: visited.size, truncated: unreachable };
}

// ---------------------------------------------------------------- message detail

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseDueDate(text) {
  const m = /due\s+(?:on|date)?\s*:?\s*(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/i.exec(text);
  if (!m || MONTHS[m[2].toLowerCase()] === undefined) return null;
  return new Date(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
}

// "Tender Number: X", "Tender No. X", "Tender no: X" - always labelled; the token may hold letters, digits, - / _
const LABELLED = /tender\s*(?:number|no)\b\.?\s*[:\-]?\s*([A-Za-z0-9](?:[A-Za-z0-9\-/_]*[A-Za-z0-9])?)/gi;

/**
 * Tender number from a message: only a number that follows an explicit "Tender Number/No" label in the
 * subject or body counts (so message ids, PO numbers, account ids and bill numbers are never picked up).
 * -> { status:'OK'|'NEEDS_REVIEW', tenderNo, candidates, reason }
 */
export function extractTenderNumber(subject, body) {
  const found = [];
  for (const [src, text] of [['subject', subject], ['body', body]]) {
    for (const m of String(text || '').matchAll(LABELLED)) {
      if (/\d/.test(m[1])) found.push({ src, value: m[1] }); // a real tender number always has a digit
    }
  }
  const distinct = [...new Map(found.map((f) => [f.value.toLowerCase(), f.value])).values()];
  if (!distinct.length) return { status: 'NEEDS_REVIEW', tenderNo: null, candidates: [], reason: 'No labelled tender number found in the subject or body.' };
  if (distinct.length > 1) return { status: 'NEEDS_REVIEW', tenderNo: null, candidates: distinct, reason: `Conflicting tender numbers: ${distinct.join(', ')}.` };
  return { status: 'OK', tenderNo: distinct[0], candidates: distinct, reason: '' };
}

/** Parse a ViewMessageDetailAction.do response. */
export function parseMessageDetail(html) {
  const doc = parseHtml(html);
  const labelled = {};
  for (const td of doc.querySelectorAll('td.formLabel')) {
    const label = norm(td.textContent).replace(/:$/, '').toLowerCase();
    const val = td.nextElementSibling;
    if (label && val && !val.querySelector('table')) labelled[label] = norm(val.textContent);
  }
  const bodyEl = doc.querySelector('.htmlAreaStyle');
  const body = norm(bodyEl?.textContent);
  const subject = labelled.subject || '';
  const titleItalic = norm(bodyEl?.querySelector('i')?.textContent).replace(/^['"‘’]+|['"‘’.]+$/g, '');
  const unit = /^NIT for\s+(.+?),\s*Tender/i.exec(subject)?.[1] || /towards\s+(.+?),\s*Tender/i.exec(subject)?.[1] || '';
  return {
    msgId: labelled['msg id'] || '',
    sentAt: labelled['sent date/time'] || '',
    sentBy: labelled['sent by'] || '',
    subject,
    body,
    tenderTitle: titleItalic,
    railwayUnit: unit,
    dueDate: parseDueDate(body),
    kind: classifyMessage(subject),
    ...extractTenderNumber(subject, body),
  };
}

export async function readMessageDetail(base, oid) {
  const res = await irepsFetch(base, MESSAGE_DETAIL_PATH, { method: 'POST', form: { oid } });
  assertSession(res);
  if (res.status !== 200) throw new TenderError('HTTP', `Message detail returned HTTP ${res.status}.`);
  const d = parseMessageDetail(res.text());
  if (!d.subject) throw new TenderError('PARSE', 'The message page had no subject (unexpected response).');
  return d;
}
