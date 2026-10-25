// "Download All Pending Correspondence": IREPS Tender Related Correspondence -> every row of
// "Correspondence - Pending" -> every letter of that row's "Pending Replies" -> letter + attachments.
//
// STRICTLY READ / DOWNLOAD ONLY. The only requests this module can issue are:
//   POST /epsn/corres/vendorRelatedCorrespondence.do          (list, empty body - like the portal menu link)
//   POST /epsn/corres/vendorCorrespondencePendingReply.do     (form: nitOid)
//   POST /epsn/corres/rly/viewpubIndltr.do                    (form: nitOid, letterID, corresId)
//   GET/POST the attachment links found in a published letter
// vendorCorresSubmitReply.do (and anything that looks like a write action) is refused in pcFetch().
//
// Every identifier is read from the live responses; nothing from a captured session is baked in.

import {
  TenderError, SESSION_MSG, log, norm, getBaseUrl, absUrl, irepsFetch, assertSession, parseHtml,
  elementActions, parseCalls, qparam, toRequest, requestKey, sniffKind, extensionFor,
  resolveIrepsDocument, looksLikeErrorPage, htmlToLines, wrapLines, buildPdf, isPdfBytes,
  createSaver, safeSegment,
} from './tender-core.js';
import { getActiveIrepsAccountContext, accountFolderLabel, assertSameAccount, ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';
import { openLedger } from './tender-ledger.js';
import { inferRoute } from './tender-workflows.js';
import { ensureDownloadSignIn } from './tender-ecm.js';
import { logDownload, flushDownloadLog, downloadRecord, downloadKey, TENDER_DOC_TYPE, LOG_DESTINATION } from '../services/download-log.js';

/** The download log of one saved file (letters keep their own "already saved" check: force / Download again). */
const logPending = (entry, role, saved) =>
  logDownload(downloadRecord({ docType: TENDER_DOC_TYPE.PENDING_CORRESPONDENCE, key: downloadKey.pending(entry.key, role) }, { filename: saved.relPath, destination: LOG_DESTINATION.LOCAL }));

export const LIST_PATH = '/epsn/corres/vendorRelatedCorrespondence.do';
export const REPLY_PATH = '/epsn/corres/vendorCorrespondencePendingReply.do';
export const VIEW_FALLBACK_PATH = '/epsn/corres/rly/viewpubIndltr.do';
const MANIFEST_KEY = 'pending-correspondence';

export const STATUS = {
  PENDING: 'PENDING', IN_PROGRESS: 'IN_PROGRESS', DOWNLOADED: 'DOWNLOADED', NO_PENDING_LETTERS: 'NO_PENDING_LETTERS',
  FAILED: 'FAILED', NEEDS_REVIEW: 'NEEDS_REVIEW', SESSION_EXPIRED: 'SESSION_EXPIRED',
};
export const NO_LETTERS_REASON = 'NO_PENDING_LETTERS_AT_DOWNLOAD_TIME';

// ---------------------------------------------------------------- read-only guard

const ALLOWED_PATHS = /\/(?:vendorRelatedCorrespondence|vendorCorrespondencePendingReply|viewpubIndltr)\.do$/i;
// Action-style names only (saveX.do, X_submit.do, deleteX.do ...): a view such as viewUploadedDoc.do or a file called
// Submission_List.pdf is not a write action.
const WRITE_LIKE = /(?:^|[a-z0-9])(?:[Ss]ubmit|[Ss]ave|[Uu]pload|[Dd]elete|[Rr]emove|[Aa]pprove|[Aa]rchive|[Ww]ithdraw|[Uu]pdate|[Ii]nsert|[Ss]ign)(?=[A-Z_.]|$)/;

/** Throws BLOCKED for anything that is not a read/view/download request. */
export function assertReadOnly(url) {
  let p;
  try {
    p = new URL(url, 'https://x.invalid/').pathname;
  } catch {
    throw new TenderError('BLOCKED', 'Malformed request refused.');
  }
  if (/SubmitReply/i.test(p)) throw new TenderError('BLOCKED', 'Submitting a correspondence reply is never done by DocLink.');
  if (ALLOWED_PATHS.test(p)) return;
  const last = p.split('/').pop() || '';
  if (/\.(?:do|jsp|action)$/i.test(last) && WRITE_LIKE.test(last)) throw new TenderError('BLOCKED', `Refused a request that looks like a write action (${p.split('/').pop()}).`);
}

/** irepsFetch behind the read-only guard. */
export async function pcFetch(base, ref, opts = {}) {
  assertReadOnly(absUrl(base, ref, opts.relativeTo));
  return irepsFetch(base, ref, opts);
}

// ---------------------------------------------------------------- retry / pacing

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(status) {
  const e = new TenderError('HTTP', `IREPS returned HTTP ${status}.`);
  e.status = status;
  return e;
}
const isTransient = (e) => e instanceof TypeError || (e.code === 'HTTP' && (e.status >= 500 || e.status === 429 || e.status === 408)) || e.code === 'EMPTY';

/** Bounded retries with backoff for transient failures only. Session expiry / validation errors are never retried. */
export async function withRetry(fn, { tries = 3, delays = [800, 2500], sleep = defaultSleep, label = '' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !isTransient(e)) throw e;
      const wait = (delays[attempt - 1] ?? delays[delays.length - 1] ?? 1000) * (e.status === 429 ? 4 : 1);
      log('Pending', `${label} transient failure (${e.message}); retry ${attempt}/${tries - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------- Stage B: Correspondence - Pending

const lc = (s) => norm(s).toLowerCase();

/** True for the Tender Related Correspondence pages (list and details). */
export function isCorrespondencePage(doc) {
  return /Tender\s+Related\s+Correspondence/i.test(norm(doc.body?.textContent || ''));
}

function columnMap(table, spec) {
  const head = table.tHead?.rows[0] || [...table.rows].find((r) => r.querySelector('th')) || table.rows[0];
  const cells = [...(head?.cells || [])].map((c) => lc(c.textContent));
  const map = {};
  for (const [key, re] of Object.entries(spec)) map[key] = cells.findIndex((t) => re.test(t));
  return { map, headerRow: head, count: cells.length };
}

const dataRows = (table, headerRow) => [...table.rows].filter((r) => r !== headerRow);
const cellText = (row, i) => (i >= 0 && row.cells[i] ? norm(row.cells[i].textContent) : '');
const fullTitle = (cell) => norm(cell?.querySelector('img[title]')?.getAttribute('title')) || norm(cell?.textContent).replace(/\s*\.{3,}\s*$/, '');

const LIST_COLS = {
  dept: /^dept/, tenderNo: /tender no/, closing: /closing/, title: /title/, replyBy: /last date/, status: /^status/, action: /^action/,
};

/**
 * Parse the list page. The Pending table is found by its SECTION HEADING ("Correspondence - Pending"),
 * never by table position, and only rows whose own Status says Pending are returned.
 *   -> { rows[], skipped[], sections[], pendingSectionFound }
 */
export function parsePendingList(html) {
  const doc = typeof html === 'string' ? parseHtml(html) : html;
  if (!isCorrespondencePage(doc)) throw new TenderError('PAGE', 'IREPS did not return the Tender Related Correspondence page.');
  const out = { rows: [], skipped: [], sections: [], pendingSectionFound: false };
  const seenOids = new Set();
  let heading = '';
  for (const el of doc.querySelectorAll('.cvap-block-heading, table')) {
    if (el.matches('.cvap-block-heading')) {
      heading = norm(el.textContent);
      out.sections.push(heading);
      continue;
    }
    const { map, headerRow } = columnMap(el, LIST_COLS);
    if (map.tenderNo < 0 || map.status < 0 || map.action < 0) continue; // layout tables / other tables
    const isPendingSection = /\bpending\b/i.test(heading) && !/lapsed|replied|previous/i.test(heading);
    if (!isPendingSection) continue; // Lapsed / Replied / anything historical: never read
    out.pendingSectionFound = true;
    for (const row of dataRows(el, headerRow)) {
      if (row.cells.length <= Math.max(map.tenderNo, map.status, map.action)) continue; // spacer / "No record found"
      const tenderNo = cellText(row, map.tenderNo);
      if (!tenderNo || /no record/i.test(row.textContent)) continue;
      const status = cellText(row, map.status);
      const base = {
        railway: cellText(row, map.dept), tenderNo, closingDate: cellText(row, map.closing),
        tenderTitle: fullTitle(row.cells[map.title]), replyDeadline: cellText(row, map.replyBy), status,
      };
      if (!/^pending$/i.test(status)) {
        out.skipped.push({ ...base, reason: `Status is "${status || 'blank'}", not Pending` });
        continue;
      }
      const act = elementActions(row.cells[map.action]).flatMap((a) => a.reqs).find((r) => /vendorCorrespondencePendingReply\.do/i.test(r.url));
      const nitOid = act ? qparam(act.url, 'nitOid') : '';
      if (!nitOid || !/^[\w-]+$/.test(nitOid)) {
        out.skipped.push({ ...base, reason: 'No pending-correspondence action with a nitOid was found on this row' });
        continue;
      }
      if (seenOids.has(nitOid)) continue;
      seenOids.add(nitOid);
      out.rows.push({ ...base, nitOid, actionPath: act.url.split('?')[0] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Stage C/D: Pending Replies

const REPLY_COLS = { letter: /letter no/, subject: /subject/, replyBy: /last date/, action: /^action/ };

function labelValue(doc, re) {
  for (const td of doc.querySelectorAll('td.formLabel')) {
    if (re.test(norm(td.textContent))) {
      const v = td.nextElementSibling;
      if (v) return { text: norm(v.textContent), title: norm(v.querySelector('img[title]')?.getAttribute('title')) };
    }
  }
  return { text: '', title: '' };
}

const inlineScripts = (doc) => [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join('\n');

/**
 * Parse a pending-replies page. Only the table under the heading "Pending Replies" is read (Lapsed and
 * Previous Replies tables on the same page are ignored).
 *   -> { tender:{tenderNo,closingDate,railway,tenderTitle}, letters[], unparsedRows[], pendingSectionFound, scripts }
 */
export function parsePendingReplies(html) {
  const doc = typeof html === 'string' ? parseHtml(html) : html;
  if (!isCorrespondencePage(doc)) throw new TenderError('PAGE', 'IREPS did not return the correspondence details page.');
  const title = labelValue(doc, /^Tender Title$/i);
  const tender = {
    tenderNo: labelValue(doc, /^Tender No\.?$/i).text,
    closingDate: labelValue(doc, /^Closing Date$/i).text,
    railway: labelValue(doc, /^Dept\/Rly/i).text,
    tenderTitle: title.title || title.text.replace(/\s*\.{3,}\s*$/, ''),
  };
  const out = { tender, letters: [], unparsedRows: [], pendingSectionFound: false, scripts: inlineScripts(doc) };
  const seen = new Set();
  let heading = '';
  // Section titles are the lone .formLabel cells that sit OUTSIDE a .dataTable; each is followed by its table.
  for (const el of doc.querySelectorAll('td.formLabel, table.dataTable')) {
    if (el.matches('td.formLabel')) {
      if (!el.closest('table.dataTable')) heading = norm(el.textContent);
      continue;
    }
    const { map, headerRow } = columnMap(el, REPLY_COLS);
    if (map.letter < 0 || map.action < 0) continue;
    if (!/^pending replies$/i.test(heading)) continue;
    out.pendingSectionFound = true;
    for (const row of dataRows(el, headerRow)) {
      if (row.cells.length <= Math.max(map.letter, map.action) || /no record/i.test(row.textContent)) continue;
      const letterText = cellText(row, map.letter);
      const view = parseCalls(`${[...row.querySelectorAll('[onclick]')].map((e) => e.getAttribute('onclick')).join(' ')} ${[...row.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).join(' ')}`)
        .find((c) => /^viewPublishedLtr$/i.test(c.fn));
      if (!view) {
        out.unparsedRows.push({ text: letterText, reason: 'No "View Published Letter" action on this Pending Replies row' });
        continue;
      }
      const [nitOid = '', corresId = '', letterId = ''] = view.args;
      const m = /^(.*?)\s+dated\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*$/i.exec(letterText);
      const letter = {
        nitOid, corresId, letterId,
        letterNo: norm(m ? m[1] : letterText), letterDate: m ? m[2] : '',
        subject: cellText(row, map.subject), replyDeadline: cellText(row, map.replyBy),
      };
      const missing = ['nitOid', 'corresId', 'letterId'].filter((k) => !letter[k]);
      const bad = ['nitOid', 'corresId', 'letterId'].filter((k) => letter[k] && !/^[\w-]+$/.test(letter[k]));
      if (missing.length || bad.length) {
        out.unparsedRows.push({ ...letter, reason: `Identifier ${missing.length ? 'missing' : 'malformed'}: ${[...missing, ...bad].join(', ')}` });
        continue;
      }
      const k = `${corresId}|${letterId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.letters.push(letter);
    }
  }
  return out;
}

/** The request the portal's viewPublishedLtr() sends: route read from the page's own script, else the documented one. */
export function buildLetterRequest(letter, scripts, pageUrl) {
  const args = [letter.nitOid, letter.corresId, letter.letterId];
  const route = inferRoute(scripts || '', 'viewPublishedLtr', args);
  const target = route || { method: 'POST', url: `${VIEW_FALLBACK_PATH}?nitOid=${args[0]}&letterID=${args[2]}&corresId=${args[1]}` }; // note: letterID
  return { ...toRequest(target.url, target.method), relativeTo: pageUrl, fromPageScript: !!route };
}

// ---------------------------------------------------------------- Stage E: the published letter

const DOC_EXT = /\.(?:pdf|docx?|xlsx?|zip|rar|7z|jpe?g|png|tiff?|rtf|txt|csv|dwg|dxf)(?:[?#]|$)/i;
const ATTACH_WORDS = /download|attach|viewdoc|opendoc|getfile|viewfile|showdoc|openfile|filedown|annex|enclos/i;

function headerFileName(headers = {}) {
  const cd = headers['content-disposition'] || '';
  const raw = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1] || /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1] || '';
  try {
    return decodeURIComponent(raw.trim());
  } catch {
    return raw.trim();
  }
}

function urlBaseName(url) {
  try {
    const n = decodeURIComponent(new URL(url, 'https://x.invalid/').pathname.split('/').pop() || '');
    return /\.[A-Za-z0-9]{2,5}$/.test(n) && !/\.(do|jsp|html?|php|aspx?)$/i.test(n) ? n : '';
  } catch {
    return '';
  }
}

/** iframe / embed / object documents inside a letter page (an embedded PDF viewer). */
function embeddedUrls(doc, base, pageUrl) {
  const out = [];
  for (const el of doc.querySelectorAll('iframe[src],embed[src],object[data]')) {
    const v = el.getAttribute('src') || el.getAttribute('data') || '';
    if (!v || /^(about:|javascript:|data:)/i.test(v)) continue;
    try {
      const u = absUrl(base, v, pageUrl);
      assertReadOnly(u);
      if (!out.includes(u)) out.push(u);
    } catch {
      /* off-origin or refused: ignore */
    }
  }
  return out;
}

/**
 * Real attachment links of a published-letter page (never images, styles, scripts or navigation).
 * A link qualifies when its target is a document file or an attachment/download-style action.
 * -> [{ req:{method,url,form}, label, id }]
 */
export function findAttachmentActions(doc, base, pageUrl, exclude = []) {
  const out = [];
  const seen = new Set();
  for (const a of elementActions(doc.body || doc.documentElement)) {
    for (const r of a.reqs) {
      let abs;
      try {
        abs = absUrl(base, r.url, pageUrl);
        assertReadOnly(abs);
      } catch {
        continue;
      }
      const path = new URL(abs).pathname;
      if (exclude.includes(abs) || /viewpubIndltr|vendorCorrespondencePendingReply|vendorRelatedCorrespondence|showHome|logout/i.test(path)) continue;
      if (!(DOC_EXT.test(abs) || ATTACH_WORDS.test(path) || /^(?:openPDF|downloadFile|downloadDoc|viewDocument|openDocument)$/i.test(r.fn || ''))) continue;
      const req = { ...toRequest(r.url, r.method === 'POST' ? 'POST' : 'GET'), relativeTo: pageUrl };
      const id = hash(requestKey({ method: req.method, url: abs.replace(/^https?:\/\/[^/]+/, ''), form: req.form }));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ req, label: a.label, id, nameHint: urlBaseName(abs) });
    }
  }
  return out;
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const SENSITIVE_PARAM = /token|session|cookie|pass|auth|secret|key/i;
/** "POST /path {params}" with credentials-looking params removed - safe to write to the manifest. */
export function describeAction(req) {
  const u = new URL(req.url, 'https://x.invalid/');
  const params = [...u.searchParams, ...(req.form || [])].filter(([k]) => !SENSITIVE_PARAM.test(k)).map(([k, v]) => `${k}=${v}`);
  return `${req.method} ${u.pathname}${params.length ? ` [${params.join('&')}]` : ''}`;
}

/**
 * Open a published letter and turn the response into a validated document.
 *   pdf   : IREPS returned the PDF itself (or an embedded PDF viewer pointing at it)
 *   file  : IREPS returned another real document type
 *   html  : a letter web page -> rendered to a PDF locally (+ the original page is kept)
 * A login / error page is never returned as a document.
 */
export async function openLetter(base, req, meta = {}) {
  const res = await pcFetch(base, req.url, { method: req.method, form: req.form, relativeTo: req.relativeTo });
  assertSession(res);
  if (res.status !== 200) throw httpError(res.status);
  const kind = sniffKind(res.bytes);
  const common = { httpStatus: res.status, contentType: res.contentType, attachments: [] };
  if (kind === 'empty') throw new TenderError('EMPTY', 'IREPS returned an empty response for the letter.');
  if (kind === 'pdf') return { ...common, form: 'pdf', bytes: res.bytes, ext: '.pdf', via: 'direct_pdf' };
  if (['zip', 'ole', 'png', 'jpg', 'gif', 'tiff', 'rtf'].includes(kind)) {
    return { ...common, form: 'file', bytes: res.bytes, ext: extensionFor(kind, res, urlBaseName(res.url)), via: 'direct_file' };
  }
  if (kind !== 'html' && kind !== 'text') throw new TenderError('NOT_DOCUMENT', `IREPS returned an unrecognised file type (${res.contentType || 'unknown'}).`);

  const html = res.text();
  const doc = parseHtml(html);
  const embedded = embeddedUrls(doc, base, res.url);
  let letterDoc = null;
  for (const url of embedded) {
    const r = await pcFetch(base, url);
    assertSession(r);
    if (r.status === 200 && isPdfBytes(r.bytes)) {
      letterDoc = { ...common, form: 'pdf', bytes: r.bytes, ext: '.pdf', via: 'embedded_pdf' };
      break;
    }
  }
  const attachments = findAttachmentActions(doc, base, res.url, embedded);
  if (letterDoc) return { ...letterDoc, attachments };

  const bad = looksLikeErrorPage(doc);
  if (bad) throw new TenderError('NO_DOCUMENT', bad);
  const lines = htmlToLines(doc);
  if (!lines.length) throw new TenderError('NO_DOCUMENT', 'The published-letter page had no readable content.');
  const preface = [
    'IREPS published correspondence letter (rendered by DocLink from the IREPS letter page)',
    meta.tenderNo ? `Tender No: ${meta.tenderNo}` : '',
    meta.letterNo ? `Letter No: ${meta.letterNo}${meta.letterDate ? `  dated ${meta.letterDate}` : ''}` : '',
    meta.subject ? `Subject: ${meta.subject}` : '',
    '-'.repeat(60),
  ].filter(Boolean);
  return { ...common, form: 'html', html, bytes: buildPdf(wrapLines([...preface, ...lines])), ext: '.pdf', via: 'html_render', attachments };
}

// ---------------------------------------------------------------- Stage E (C): attachments

/** Download one attachment. -> { bytes, ext, fileName } ; throws for login / HTML / empty responses. */
export async function fetchAttachment(base, att) {
  const res = await pcFetch(base, att.req.url, { method: att.req.method, form: att.req.form, relativeTo: att.req.relativeTo });
  assertSession(res);
  if (res.status !== 200) throw httpError(res.status);
  let bytes = res.bytes;
  let ext;
  const kind = sniffKind(bytes);
  if (kind === 'empty') throw new TenderError('EMPTY', 'IREPS returned an empty attachment.');
  const given = headerFileName(res.headers) || att.nameHint || '';
  if (kind === 'html') {
    const r = await resolveIrepsDocument(base, res, { allowHtml: false, allowAnyFile: true, nameHint: given });
    bytes = r.bytes;
    ext = r.ext;
  } else {
    ext = extensionFor(kind, res, given);
  }
  let fileName = given && /\.[A-Za-z0-9]{2,5}$/.test(given) ? given : `${given || att.label || 'attachment'}${ext}`;
  fileName = fileName.split(/[\\/]/).pop();
  return { bytes, ext, fileName, kind: sniffKind(bytes), httpStatus: res.status, contentType: res.contentType };
}

// ---------------------------------------------------------------- naming

const dateSeg = (d) => String(d || '').replace(/\//g, '-');

export function letterFileName(letter, ext, { withId = false } = {}) {
  const no = safeSegment(letter.letterNo || letter.letterId, 40);
  const subj = safeSegment(letter.subject, 60);
  const parts = ['Correspondence', no, dateSeg(letter.letterDate), letter.subject ? subj : '', withId ? letter.letterId : ''].filter(Boolean);
  return `${parts.join('_')}${ext}`;
}

export const letterKey = (accountId, l) => `${accountId}|${l.nitOid}|${l.corresId}|${l.letterId}`;

// ---------------------------------------------------------------- saved-file validation

async function verifySaved(saved, bytes, role) {
  const checks = { savedSize: saved.size, expectedSize: bytes.length, chromeVerified: false };
  if (saved.size !== bytes.length) throw new TenderError('SAVE', 'Saved size does not match the downloaded content.');
  try {
    const [item] = await chrome.downloads.search({ id: saved.downloadId });
    if (item) {
      if (item.state !== 'complete' || item.exists === false) throw new TenderError('SAVE', 'Chrome reports the file was not saved.');
      if (typeof item.fileSize === 'number' && item.fileSize > 0 && item.fileSize !== bytes.length) throw new TenderError('SAVE', 'The file on disk has a different size from the download.');
      checks.chromeVerified = true;
    }
  } catch (e) {
    if (e instanceof TenderError) throw e;
  }
  if (role === 'letter' && sniffKind(bytes) === 'html') throw new TenderError('NOT_DOCUMENT', 'A web page was about to be saved as the letter.');
  return checks;
}

// ---------------------------------------------------------------- job

const blank = () => ({ records: {}, letters: {} });

function summarize(state, run) {
  const letters = Object.values(state.letters).filter((l) => run.has(l.key));
  const records = Object.values(state.records).filter((r) => run.has(r.nitOid));
  const count = (st) => letters.filter((l) => l.status === st).length;
  const unavailable = letters.filter((l) => l.status === STATUS.FAILED && l.unavailable).length;
  return {
    pendingRecords: records.length,
    lettersDiscovered: letters.length,
    lettersDownloaded: count(STATUS.DOWNLOADED),
    alreadyDownloaded: letters.filter((l) => l.status === STATUS.DOWNLOADED && l.alreadyDownloaded).length,
    attachmentsDownloaded: letters.reduce((n, l) => n + l.files.filter((f) => f.role === 'attachment' && f.status === 'DOWNLOADED' && !f.previous).length, 0),
    unavailable,
    failed: count(STATUS.FAILED) - unavailable + records.filter((r) => r.status === STATUS.FAILED && !r.letterKeys.length).length,
    needsReview: count(STATUS.NEEDS_REVIEW) + records.filter((r) => r.status === STATUS.NEEDS_REVIEW && !r.letterKeys.length).length,
    noPendingLetters: records.filter((r) => r.status === STATUS.NO_PENDING_LETTERS).length,
    sessionExpired: count(STATUS.SESSION_EXPIRED),
  };
}

const publicLetter = ({ key, req, ...l }) => ({ ...l, key: undefined, files: l.files.map(({ downloadId, ...f }) => f) });
const publicAccount = (a) => ({ irepsAccountId: a.irepsAccountId, companyName: a.companyName, operatingUnit: a.operatingUnit });

/**
 * Download every letter currently shown as pending.
 *   mode 'all'   : every pending record (letters already saved are skipped, never duplicated)
 *   mode 'retry' : only records / letters that did not finish last time
 *   force        : download letters again even if the manifest says they were saved
 * Callbacks: onProgress(text), onAccount(account), onEvent({type:'records'|'record'|'letter'|'summary', ...}).
 */
export async function downloadPendingCorrespondence({ mode = 'all', force = false, onProgress = () => {}, onAccount = () => {}, onEvent = () => {}, sleep = defaultSleep, pace = 200 } = {}) {
  await ensureDownloadSignIn(); // Recon sign-in: every download is logged for the signed-in user
  const base = await getBaseUrl();
  onProgress('Verifying IREPS account...');
  const account = await getActiveIrepsAccountContext({ base });
  onAccount(account);
  if (!account.authenticated) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
  if (!account.verified) throw new TenderError('ACCOUNT', ACCOUNT_UNVERIFIED_MSG);
  const folderLabel = accountFolderLabel(account);
  const ledger = await openLedger(account.irepsAccountId);
  const state = ledger.manifest(MANIFEST_KEY) || blank();
  state.records ||= {};
  state.letters ||= {};
  const run = new Set(); // keys / nitOids touched by THIS run
  const jobSaver = createSaver({ accountLabel: folderLabel, subPath: ['Correspondence', 'Pending'], conflict: 'overwrite' });
  let aborted = null;
  let skipped = [];

  const persist = async () => {
    ledger.setManifest(MANIFEST_KEY, state);
    await ledger.save(); // progress is kept in extension storage only; no download_manifest.json is saved
  };
  const emitLetter = (l) => onEvent({ type: 'letter', letter: publicLetter(l), key: l.key });
  const emitRecord = (r) => onEvent({ type: 'record', record: { ...r, letterKeys: undefined }, nitOid: r.nitOid });
  const emitSummary = () => onEvent({ type: 'summary', summary: summarize(state, run) });
  const abortWith = (e) => {
    aborted = { code: e.code, message: e.code === 'SESSION_EXPIRED' ? SESSION_MSG : e.message };
  };

  // ---- Stage A/B: the real Correspondence page, then only its Pending section
  onProgress('Opening Tender Related Correspondence...');
  log('Pending', `POST ${LIST_PATH}`);
  const listRes = await withRetry(async () => {
    const r = await pcFetch(base, LIST_PATH, { method: 'POST', form: {} });
    assertSession(r);
    if (r.status !== 200) throw httpError(r.status);
    return r;
  }, { sleep, label: 'correspondence list' });
  const list = parsePendingList(listRes.text());
  skipped = list.skipped;
  log('Pending', `Sections: ${list.sections.join(' | ') || '(none)'}; pending rows: ${list.rows.length}; skipped rows: ${list.skipped.length}`);

  const tenderCount = new Map();
  for (const r of list.rows) tenderCount.set(lc(r.tenderNo), (tenderCount.get(lc(r.tenderNo)) || 0) + 1);
  const records = list.rows.map((row) => {
    const prev = state.records[row.nitOid];
    const rec = {
      accountId: account.irepsAccountId, ...row,
      folderName: tenderCount.get(lc(row.tenderNo)) > 1 ? `${row.tenderNo}_${row.nitOid}` : row.tenderNo,
      prevStatus: prev?.status || '', status: STATUS.PENDING, error: '', lettersPending: 0, letterKeys: prev?.letterKeys || [], updatedAt: new Date().toISOString(),
    };
    state.records[row.nitOid] = rec;
    run.add(row.nitOid);
    return rec;
  });
  onEvent({ type: 'records', records: records.map((r) => ({ ...r, letterKeys: undefined })), skipped, pendingSectionFound: list.pendingSectionFound });

  if (!records.length) {
    onProgress('No pending correspondence found');
    await persist();
    emitSummary();
    return { account: publicAccount(account), empty: true, summary: summarize(state, run), skipped, aborted, folder: `Downloads/${jobSaver.root}/` };
  }

  // ---- Stage C..E per record (sequential: conservative towards IREPS)
  for (const [ri, rec] of records.entries()) {
    if (aborted) {
      rec.status = STATUS.SESSION_EXPIRED;
      emitRecord(rec);
      continue;
    }
    if (mode === 'retry' && rec.prevStatus === STATUS.DOWNLOADED) {
      rec.status = STATUS.DOWNLOADED; // finished last time: nothing to retry, nothing re-downloaded
      rec.letterKeys.forEach((k) => run.add(k));
      emitRecord(rec);
      continue;
    }
    rec.status = STATUS.IN_PROGRESS;
    emitRecord(rec);
    onProgress(`Pending ${ri + 1}/${records.length}: ${rec.tenderNo}`);
    try {
      await assertSameAccount(account, { base });
      await sleep(pace);
      const detail = await withRetry(async () => {
        const r = await pcFetch(base, REPLY_PATH, { method: 'POST', form: { nitOid: rec.nitOid } });
        assertSession(r);
        if (r.status !== 200) throw httpError(r.status);
        return r;
      }, { sleep, label: `pending replies ${rec.tenderNo}` });
      const page = parsePendingReplies(detail.text());
      if (page.tender.tenderNo && lc(page.tender.tenderNo) !== lc(rec.tenderNo)) {
        rec.status = STATUS.NEEDS_REVIEW;
        rec.error = `The details page is for tender ${page.tender.tenderNo}, not ${rec.tenderNo}; nothing was downloaded.`;
        emitRecord(rec);
        await persist();
        emitSummary();
        continue;
      }
      rec.tenderTitle = page.tender.tenderTitle || rec.tenderTitle;
      rec.closingDate = page.tender.closingDate || rec.closingDate;
      rec.lettersPending = page.letters.length;
      rec.letterKeys = [];
      if (!page.letters.length && !page.unparsedRows.length) {
        rec.status = STATUS.NO_PENDING_LETTERS;
        rec.reason = NO_LETTERS_REASON;
        log('Pending', `${rec.tenderNo}: ${NO_LETTERS_REASON}`);
        emitRecord(rec);
        await persist();
        emitSummary();
        continue;
      }
      const saver = createSaver({ accountLabel: folderLabel, subPath: ['Correspondence', 'Pending', rec.folderName], conflict: 'overwrite' });

      // register every letter first so the UI shows the whole queue before downloads start
      const items = [];
      for (const l of page.letters) {
        const key = letterKey(account.irepsAccountId, l);
        const prev = state.letters[key];
        const entry = {
          key, accountId: account.irepsAccountId, tenderNo: rec.tenderNo, ...l, nitOid: l.nitOid,
          status: STATUS.PENDING, error: '', code: '', unavailable: false, files: prev?.files || [], attachmentsComplete: prev?.attachmentsComplete || false,
          sourceAction: '', alreadyDownloaded: false, downloadedAt: prev?.downloadedAt || '',
        };
        if (l.nitOid !== rec.nitOid) {
          entry.status = STATUS.NEEDS_REVIEW;
          entry.error = 'The letter belongs to a different nitOid than the pending record; not downloaded.';
        }
        state.letters[key] = entry;
        run.add(key);
        rec.letterKeys.push(key);
        items.push({ entry, letter: l });
        emitLetter(entry);
      }
      page.unparsedRows.forEach((u, i) => {
        const key = `${account.irepsAccountId}|${rec.nitOid}|unparsed${i}`;
        state.letters[key] = { key, accountId: account.irepsAccountId, tenderNo: rec.tenderNo, nitOid: rec.nitOid, corresId: u.corresId || '', letterId: u.letterId || '', letterNo: u.letterNo || u.text || '', letterDate: u.letterDate || '', subject: u.subject || '', replyDeadline: u.replyDeadline || '', status: STATUS.NEEDS_REVIEW, error: u.reason, code: 'UNPARSED', unavailable: false, files: [], attachmentsComplete: false, sourceAction: '', downloadedAt: '' };
        run.add(key);
        rec.letterKeys.push(key);
        emitLetter(state.letters[key]);
      });

      for (const { entry, letter } of items) {
        if (entry.status === STATUS.NEEDS_REVIEW) continue;
        if (aborted) {
          entry.status = STATUS.SESSION_EXPIRED;
          emitLetter(entry);
          continue;
        }
        try {
          await processLetter({ base, saver, state, rec, entry, letter, page, detailUrl: detail.url, force, sleep, pace, onProgress });
        } catch (e) {
          if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') {
            entry.status = STATUS.SESSION_EXPIRED;
            entry.error = e.message;
            abortWith(e);
          } else {
            entry.status = STATUS.FAILED;
            entry.error = e.message;
            entry.code = e.code || '';
            entry.unavailable = ['NO_DOCUMENT', 'NOT_DOCUMENT', 'EMPTY'].includes(e.code);
            log('Pending', `letter ${entry.letterId} failed: ${e.message}`);
          }
        }
        emitLetter(entry);
        emitSummary();
        await persist();
      }
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') {
        abortWith(e);
        rec.status = STATUS.SESSION_EXPIRED;
        rec.error = e.message;
      } else {
        rec.status = STATUS.FAILED;
        rec.error = e.message;
        log('Pending', `record ${rec.tenderNo} failed: ${e.message}`);
      }
      emitRecord(rec);
      await persist();
      emitSummary();
      continue;
    }
    const ls = rec.letterKeys.map((k) => state.letters[k].status);
    rec.status = ls.some((s) => s === STATUS.SESSION_EXPIRED) ? STATUS.SESSION_EXPIRED
      : ls.some((s) => s === STATUS.FAILED) ? STATUS.FAILED
      : ls.some((s) => s === STATUS.NEEDS_REVIEW) ? STATUS.NEEDS_REVIEW
      : STATUS.DOWNLOADED;
    rec.updatedAt = new Date().toISOString();
    emitRecord(rec);
    await persist();
    emitSummary();
  }

  await persist();
  emitSummary();
  flushDownloadLog();
  onProgress(aborted ? 'Stopped: ' + aborted.message : 'Pending correspondence download complete.');
  return { account: publicAccount(account), empty: false, summary: summarize(state, run), skipped, aborted, folder: `Downloads/${jobSaver.root}/` };
}

async function processLetter({ base, saver, state, rec, entry, letter, page, detailUrl, force, sleep, pace, onProgress }) {
  const prevLetterFile = !force && entry.files.find((f) => f.role === 'letter' && f.status === 'DOWNLOADED');
  if (!force && entry.attachmentsComplete && prevLetterFile) {
    entry.status = STATUS.DOWNLOADED;
    entry.alreadyDownloaded = true;
    entry.files = entry.files.map((f) => ({ ...f, previous: true }));
    return;
  }
  entry.status = STATUS.IN_PROGRESS;
  entry.error = '';
  entry.code = '';
  entry.unavailable = false;
  const req = buildLetterRequest(letter, page.scripts, detailUrl);
  entry.sourceAction = describeAction(req);
  onProgress(`${rec.tenderNo}: letter ${letter.letterNo || letter.letterId}`);
  await sleep(pace);

  const opened = await withRetry(() => openLetter(base, req, { tenderNo: rec.tenderNo, letterNo: letter.letterNo, letterDate: letter.letterDate, subject: letter.subject }), { sleep, label: `letter ${letter.letterId}` });
  const files = force ? [] : entry.files.filter((f) => f.status === 'DOWNLOADED').map((f) => ({ ...f, previous: true }));

  // ---- the letter itself
  if (!prevLetterFile) {
    if (opened.form !== 'html' && opened.ext === '.pdf' && !isPdfBytes(opened.bytes)) throw new TenderError('NOT_PDF', 'The letter was not a valid PDF.');
    const taken = (name) => Object.values(state.letters).some((o) => o.key !== entry.key && o.tenderNo === rec.tenderNo && o.files.some((f) => lc(f.fileName) === lc(name) && f.role === 'letter'));
    let name = letterFileName(letter, opened.ext);
    if (taken(name)) name = letterFileName(letter, opened.ext, { withId: true });
    const saved = await saver.save('', name, opened.bytes);
    const check = await verifySaved(saved, opened.bytes, 'letter');
    logPending(entry, 'letter', saved);
    files.push({
      role: 'letter', fileName: saved.relPath, relPath: saved.relPath, status: 'DOWNLOADED', size: saved.size, downloadedAt: new Date().toISOString(), downloadId: saved.downloadId,
      validation: { ok: true, kind: opened.form === 'html' ? 'pdf (rendered from HTML)' : opened.form, source: opened.via, extension: opened.ext, httpStatus: opened.httpStatus, contentType: opened.contentType, pdfSignature: opened.ext === '.pdf' ? isPdfBytes(opened.bytes) : null, ...check },
    });
    if (opened.form === 'html') {
      const htmlName = saved.relPath.replace(/\.pdf$/i, '') + '.html';
      const s2 = await saver.save('', htmlName, new TextEncoder().encode(opened.html), 'text/html');
      files.push({ role: 'letter_source_html', fileName: s2.relPath, relPath: s2.relPath, status: 'DOWNLOADED', size: s2.size, downloadedAt: new Date().toISOString(), downloadId: s2.downloadId, note: 'original IREPS letter page' });
    }
    entry.downloadedAt = new Date().toISOString();
  }

  // ---- attachments the letter really exposes
  let attFailed = 0;
  log('Pending', `letter ${letter.letterId}: ${opened.attachments.length} attachment link(s)`);
  for (const att of opened.attachments) {
    const done = files.find((f) => f.role === 'attachment' && f.attId === att.id && f.status === 'DOWNLOADED');
    if (done) continue;
    try {
      await sleep(pace);
      const got = await withRetry(() => fetchAttachment(base, att), { sleep, label: `attachment ${att.id}` });
      const name = `Attachment_${safeSegment(letter.letterNo || letter.letterId, 40)}_${got.fileName}`;
      const saved = await saver.save('', name, got.bytes);
      const check = await verifySaved(saved, got.bytes, 'attachment');
      logPending(entry, `attachment:${att.id}`, saved);
      files.push({
        role: 'attachment', attId: att.id, fileName: saved.relPath, relPath: saved.relPath, originalName: got.fileName, status: 'DOWNLOADED', size: saved.size, downloadedAt: new Date().toISOString(), downloadId: saved.downloadId,
        validation: { ok: true, kind: got.kind, extension: got.ext, httpStatus: got.httpStatus, contentType: got.contentType, ...check },
      });
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      attFailed++;
      files.push({ role: 'attachment', attId: att.id, fileName: '', originalName: att.nameHint || att.label, status: 'FAILED', error: e.message, code: e.code || '' });
      log('Pending', `attachment ${att.id} failed: ${e.message}`);
    }
  }
  entry.files = files;
  entry.attachmentsComplete = attFailed === 0;
  if (attFailed) {
    entry.status = STATUS.FAILED;
    entry.error = `${attFailed} attachment(s) could not be downloaded (the letter itself was saved).`;
    entry.code = 'ATTACHMENT';
  } else {
    entry.status = STATUS.DOWNLOADED;
  }
}
