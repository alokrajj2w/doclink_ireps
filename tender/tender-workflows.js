// "Download Tender Documents": one handler per IREPS workflow.
// Every identifier (nitId, nitOid, tenderOID, letter ids, tokens, dates...) is read from the live
// IREPS responses; nothing captured from a previous session is baked in.
//
// Financial and Commercial Tabulation are downloaded from the tender's row (or its row in IREPS "Closed
// Tenders"); OUT OF SCOPE (never requested, enforced in tender-core.isExcludedUrl):
//   Techno-Commercial Tabulation (TECH-TAB) and any other commTboPdfAction.do pdfType.

import {
  TenderError, SESSION_MSG, log, norm,
  getBaseUrl, irepsFetch, assertSession, parseHtml, formParams, findForm,
  elementActions, parseCalls, qparam, toRequest, requestKey, fetchDocument, createSaver, safeSegment,
} from './tender-core.js';
import { getActiveIrepsAccountContext, assertSameAccount, accountFolderLabel, ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';
import { printPageToPdf } from './tender-print.js';
import { searchTender, findTenderRows, findTenderRowsLoose, fmtDate } from './tender-search.js';
import { ecmDocumentFor, tenderEcmSink, ensureDownloadSignIn, CATEGORY_ECM_KIND } from './tender-ecm.js';
import { loadDownloadLogConfig, preflightDownloads, confirmRedownload, logDownload, flushDownloadLog, downloadRecord, downloadKey, TENDER_DOC_TYPE, LOG_DESTINATION } from '../services/download-log.js';

const INBOX_PATH = '/epsn/vendorInboxLink.do';
const DEFAULT_AJAX_PATH = '/epsn/supply/tds/ajxdata.do';
const CORRES_PATH = '/epsn/corres/vendorCorrespondencePendingReply.do';
const CORRES_LIST_PATH = '/epsn/corres/vendorRelatedCorrespondence.do';
const CORRES_VIEW_FALLBACK = '/epsn/corres/rly/viewpubIndltr.do';
const MAX_INBOX_PAGES = 15;
const INBOX_WINDOW_DAYS = 90;
const INBOX_WINDOWS = 5;

export const EXCLUSIONS = ['Techno-Commercial Tabulation'];
export const CATEGORY_KEYS = ['tenderPdf', 'attachments', 'corrigenda', 'myOffer', 'negotiation', 'counterOffer', 'loa', 'correspondence', 'financialTabulation', 'commercialTabulation'];
const DATE_RE = /\b\d{1,2}[-/ ](?:\d{1,2}|[A-Za-z]{3})[-/ ]\d{2,4}\b/;
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- result model

export function newCategory(category) {
  return { category, status: 'NOT_AVAILABLE', discovered: 0, downloaded: 0, failed: 0, files: [], warnings: [], note: '' };
}

/** DOWNLOADED | NOT_AVAILABLE | FAILED | PARTIAL */
export function finalize(r) {
  if (r.discovered === 0) r.status = 'NOT_AVAILABLE';
  else if (r.downloaded === 0) r.status = 'FAILED';
  else if (r.failed > 0 || r.downloaded < r.discovered) r.status = 'PARTIAL';
  else r.status = 'DOWNLOADED';
  return r;
}

function failedCategory(category, message) {
  const r = newCategory(category);
  r.discovered = 1;
  r.failed = 1;
  r.note = message;
  r.files.push({ fileName: '', status: 'FAILED', error: message });
  return finalize(r);
}

/** Remove duplicate requests (same method/path/params) - different letters are never merged by title. */
export function dedupeItems(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (!it.req) return true;
    const k = requestKey(it.req);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The single download path used by every category: issue the request exactly as the IREPS page
 * would, validate/resolve the response into a real document, save it, return the file record.
 *   action = { req, opts, subdir, fileName(ext) -> string, id, category, before?(), print? }
 * `print`: a letter that IREPS only serves as a web page is printed by Chrome itself (Ctrl+P, see
 * tender-print.js) instead of the text-only rendering; if Chrome cannot print, the text PDF is kept.
 * Under "Save to: ECM / S3" (run.ecm) a document whose category has an ECM kind goes to the ECM
 * folder of the account's unit; when the ECM does not take it, it is saved locally as before.
 * The file record then carries `ecm` (and no relPath unless a local copy was made).
 */
export async function resolveAndDownloadIrepsDocument(action, run) {
  if (action.before) await action.before();
  let doc = await fetchDocument(run.base, { ...action.req, relativeTo: action.req.relativeTo || run.ctx.searchUrl },
    { allowHtml: !!action.allowHtml, allowAnyFile: !!action.allowAnyFile, nameHint: action.nameHint || '' });
  let printError = '';
  if (doc.kind === 'html' && action.print) {
    try {
      doc = { ...doc, bytes: await printPageToPdf(doc.page), converted: false, printed: true };
    } catch (e) {
      printError = e.message;
      log('Download', `Chrome print failed, keeping the text rendering: ${e.message}`);
    }
  }
  log('Download', `Validating document (${doc.kind}${doc.printed ? ', printed by Chrome' : doc.converted ? ', rendered from HTML' : ''})`);
  const fileName = action.fileName(doc.ext);
  const ecmDoc = run.ecm ? ecmDocumentFor(action.category, action, run.ctx) : null;
  let saved;
  let ecm = null;
  if (ecmDoc) {
    const mimeType = /\.pdf$/i.test(fileName) ? 'application/pdf' : doc.contentType || 'application/octet-stream';
    ({ ecm, local: saved } = await run.ecm.save({ ...ecmDoc, bytes: doc.bytes, filename: fileName, mimeType },
      () => run.saver.save(action.subdir, fileName, doc.bytes)));
    log('Download', `ECM ${ecm.status}${ecm.site ? ` (${ecm.site})` : ''}: ${fileName}`);
  } else {
    saved = await run.saver.save(action.subdir, fileName, doc.bytes);
  }
  const size = saved ? saved.size : doc.bytes.length;
  // the download log (no-op when it is off); the HTML companion of a rendered page is not a document of its own
  logDownload(downloadRecord(
    { docType: TENDER_DOC_TYPE[action.category] || 'tender_document', key: downloadKey.tender(action.category, run.ctx.tenderNo, action.id) },
    { filename: saved ? saved.relPath.split('/').pop() : fileName, ecm, account: run.account }
  ));
  const out = [{ fileName: saved ? saved.relPath.split('/').pop() : fileName, relPath: saved ? saved.relPath : null, status: 'DOWNLOADED', id: action.id || '', downloadId: saved ? saved.downloadId : null, size, converted: !!doc.converted,
    ...(doc.printed ? { printed: true } : {}),
    title: action.meta?.title || '', docDate: action.meta?.docDate || '', downloadedAt: new Date().toISOString(),
    validation: { kind: doc.kind, extension: doc.ext, httpStatus: doc.httpStatus, contentType: doc.contentType || '', bytes: size },
    ...(ecm ? { ecm } : {}) }];
  if (doc.kind === 'html' && !doc.printed) {
    // Keep the complete original page next to the text rendering: nothing from the letter is lost.
    // (A page Chrome printed is already complete, as Ctrl+P would save it.)
    const htmlName = fileName.replace(/\.pdf$/i, '') + '.html';
    const savedHtml = await run.saver.save(action.subdir, htmlName, new TextEncoder().encode(doc.html), 'text/html');
    out.push({ fileName: savedHtml.relPath.split('/').pop(), relPath: savedHtml.relPath, status: 'DOWNLOADED', id: action.id || '', downloadId: savedHtml.downloadId, size: savedHtml.size, note: 'original HTML' });
  }
  return { files: out, converted: doc.kind === 'html' && !doc.printed, printError };
}

const LEDGER_BUCKET = { CORRIGENDA: 'corrigenda', NEGOTIATION: 'letters', COUNTER_OFFER: 'letters', LOA: 'letters', CORRESPONDENCE: 'letters', FINANCIAL_TABULATION: 'letters', COMMERCIAL_TABULATION: 'letters' };

const ITEM_CONCURRENCY = 3;

/**
 * The download log's check (services/download-log.js): which of a category's documents this
 * user already downloaded to the same destination, or (Save to: ECM) the ECM already holds.
 * The panel asks which to download again; a "same answer for the rest of this run" is kept
 * on run.redownloadMemo (shared by every tender of a job). null when the log is off.
 */
const itemId = (it) => String(it.id ?? '') || '-'; // the NIT itself may have no id

async function checkAlreadyDownloaded(run, result, items, build) {
  if (!items.length || !(await loadDownloadLogConfig())) return null;
  const toEcm = Boolean(run.ecm && CATEGORY_ECM_KIND[result.category]);
  const candidates = items.map((it) => ({
    id: itemId(it),
    label: `${run.ctx.tenderNo} - ${build(it).meta?.title || it.id || result.category}`,
    log: { docType: TENDER_DOC_TYPE[result.category] || 'tender_document', key: downloadKey.tender(result.category, run.ctx.tenderNo, it.id) },
    ecm: toEcm ? ecmDocumentFor(result.category, build(it), run.ctx) : null,
  }));
  const memo = run.redownloadMemo || (run.redownloadMemo = {});
  const ask = (question) => {
    // categories run in parallel: their questions wait in turn, so a remembered answer applies at once
    const answered = (memo.turn || Promise.resolve()).then(async () => {
      const ids = [...new Set([...question.alreadyDownloaded, ...question.inEcm].map((q) => q.id))];
      if (memo.answer === 'skip') return { redownload: [] };
      if (memo.answer === 'all') return { redownload: ids };
      const answer = await confirmRedownload({ ...question, forRun: true });
      if (answer && answer.sameForRun) memo.answer = answer.redownload.length === 0 ? 'skip' : answer.redownload.length === ids.length ? 'all' : undefined;
      return answer;
    });
    memo.turn = answered.catch(() => {});
    return answered;
  };
  const checked = await preflightDownloads(candidates, { destination: toEcm ? LOG_DESTINATION.ECM : LOG_DESTINATION.LOCAL, account: run.account, ask });
  for (const w of checked.warnings) result.warnings.push(w);
  return checked;
}

async function downloadItems(run, result, items, build) {
  items = dedupeItems(items);
  const bucket = LEDGER_BUCKET[result.category];
  const ledgerKey = (it) => `${result.category}|${run.ctx.tenderNo}|${it.id}`;
  const logged = await checkAlreadyDownloaded(run, result, items, build);
  if (logged && logged.checked) {
    // the signed-in user's own download log decides (the ledger is still kept, below)
    result.skippedFiles = items.filter((it) => logged.skip.has(itemId(it))).map((it) => ({ id: it.id || '', title: build(it).meta?.title || '', skip: logged.skip.get(itemId(it)) }));
    result.alreadyDownloaded = result.skippedFiles.length;
    items = items.filter((it) => !logged.skip.has(itemId(it)));
  } else if (run.ledger && bucket && run.ledgerMode === 'skip') {
    // scheduled jobs: only what has not been downloaded before (also when the download log cannot answer)
    const fresh = items.filter((it) => !run.ledger.has(bucket, ledgerKey(it)));
    result.alreadyDownloaded = items.length - fresh.length;
    items = fresh;
  }
  result.discovered = items.length;
  if (items.length) await assertSameAccount(run.account, { base: run.base }); // steps run in parallel: re-check before this category starts saving
  // up to ITEM_CONCURRENCY documents of one category download at the same time; results keep the list order
  const outcomes = new Array(items.length);
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (!fatal && next < items.length) {
      const i = next++;
      const item = items[i];
      try {
        if (item.skip) throw new TenderError(item.skip.code, item.skip.message);
        const { files, converted, printError } = await resolveAndDownloadIrepsDocument({ category: result.category, ...build(item) }, run);
        if (run.ledger && bucket) run.ledger.mark(bucket, ledgerKey(item));
        outcomes[i] = { ok: true, files, converted, printError };
      } catch (e) {
        if (e.code === 'SESSION_EXPIRED' || e.code === 'EXCLUDED') { fatal = fatal || e; return; }
        outcomes[i] = { ok: false, item, error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
  if (fatal) throw fatal;
  for (const o of outcomes) {
    if (!o) continue;
    if (o.ok) {
      result.downloaded++;
      result.files.push(...o.files);
      if (o.printError) result.warnings.push(`Chrome could not print these letters as Ctrl+P would: ${o.printError}`);
      if (o.converted) {
        result.warnings.push('Some documents were printable web pages. A text-only PDF rendering and the complete original .html were saved; the PDF does not keep the page layout.');
      }
    } else {
      result.failed++;
      result.files.push({ fileName: '', id: o.item.id || '', status: 'FAILED', error: o.error.message, code: o.error.code || '' });
      log(result.category, `failed ${o.item.id || ''}: ${o.error.message}`);
    }
  }
  result.warnings = [...new Set(result.warnings)];
  flushDownloadLog();
  return finalize(result);
}

// ---------------------------------------------------------------- identifiers
// Each identifier has its own meaning and is only ever filled from a parameter of the same name.
// (nitOid also has a lower-priority source, see ensureNitOid.)

const ID_PARAMS = { nitid: 'nitId', nitoid: 'nitOid', tenderoid: 'tenderOID', tdid: 'tdId', tdversion: 'tdVersion', bidid: 'bidId' };
const SOURCE_RANK = { inbox: 3, correspondence_list: 2, row_oid: 1 };

function setId(run, key, value, source) {
  if (!value) return;
  const cur = run.ids[key];
  if (!cur) {
    run.ids[key] = value;
    run.idSource[key] = source;
    log('Tender', `${key} discovered (${source})`);
  } else if (cur !== value) {
    // only nitOid has competing sources of different reliability; every other id keeps its first (tender-row) value
    if (key === 'nitOid' && (SOURCE_RANK[source] || 0) > (SOURCE_RANK[run.idSource[key]] || 0)) {
      log('Tender', `${key} replaced by a more reliable source (${source})`);
      run.ids[key] = value;
      run.idSource[key] = source;
    } else {
      log('Tender', `${key} conflict ignored (${source})`);
    }
  }
}

function noteIds(run, url, source) {
  let u;
  try {
    u = new URL(url, 'https://x.invalid/');
  } catch {
    return;
  }
  for (const [k, v] of u.searchParams) {
    const key = ID_PARAMS[k.toLowerCase()];
    if (key) setId(run, key, v, source);
  }
}

const allReqs = (actions) => actions.flatMap((a) => a.reqs.map((r) => ({ ...r, action: a })));
const pathOf = (u) => {
  try {
    return new URL(u, 'https://x.invalid/').pathname;
  } catch {
    return String(u);
  }
};

// ---------------------------------------------------------------- page-script route inference

/**
 * Reconstruct the URL that a page's own helper (e.g. showPubCorriDetail, viewPublishedLtr) builds,
 * by reading the helper's source out of the live page instead of assuming a route.
 *   -> { method, url } | null
 */
export function inferRoute(scriptText, fnName, argValues) {
  const src = scriptText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  const at = src.search(new RegExp(`function\\s+${fnName}\\s*\\(`, 'i'));
  if (at < 0) return null;
  const rest = src.slice(at);
  const next = rest.slice(10).search(/\nfunction\s/);
  const body = next < 0 ? rest.slice(0, 5000) : rest.slice(0, next + 10);
  const params = (/function\s+\w+\s*\(([^)]*)\)/.exec(body)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const vars = {};
  for (const m of body.matchAll(/\bvar\s+(\w+)\s*=\s*(['"])([^'"]*)\2\s*;?/g)) if (m[1] !== 'url') vars[m[1]] = m[3];
  params.forEach((p, i) => (vars[p] = argValues[i] ?? ''));

  let chosen = null;
  for (const m of body.matchAll(/(?:\bvar\s+)?\burl\s*=\s*([^;]+);/g)) {
    const before = body.slice(Math.max(0, m.index - 160), m.index);
    const cond = [...before.matchAll(/(\w+)\s*==\s*["']([^"']*)["']/g)].pop();
    if (cond && vars[cond[1]] !== undefined && vars[cond[1]] !== cond[2]) continue;
    // a condition on a variable we cannot resolve is not a match unless it is the only assignment
    if (cond && vars[cond[1]] === undefined) {
      chosen = chosen || m[1];
      continue;
    }
    chosen = m[1];
  }
  if (!chosen) return null;

  let url = '';
  for (const tok of chosen.match(/(['"])(?:(?!\1).)*\1|[A-Za-z_$][\w$]*/g) || []) {
    if (/^['"]/.test(tok)) url += tok.slice(1, -1);
    else if (vars[tok] !== undefined) url += vars[tok];
    else return null; // an identifier we cannot resolve: do not guess
  }
  const method = /postRequest\w*\s*\(/i.test(body) ? 'POST' : 'GET';
  return { method, url };
}

const inlineScripts = (doc) => [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join('\n');

// ---------------------------------------------------------------- NIT page (shared)

function nitPage(run) {
  // cached as a promise so steps running in parallel share one request
  if (!run.nitP) run.nitP = loadNitPage(run).catch((e) => { run.nitP = null; throw e; });
  return run.nitP;
}

async function loadNitPage(run) {
  const act = allReqs(run.ctx.row.actions).find((r) => /nitPublish\.do/i.test(pathOf(r.url)));
  if (!act) throw new TenderError('NO_NIT', 'The tender row has no View NIT action.');
  noteIds(run, act.url, 'row_action');
  run.ctx.nitPageUrl = act.url;
  const res = await irepsFetch(run.base, act.url, { relativeTo: run.ctx.searchUrl });
  assertSession(res);
  if (res.status !== 200) throw new TenderError('HTTP', `View NIT page returned HTTP ${res.status}.`);
  const doc = parseHtml(res.text());
  log('Tender', `View NIT page loaded (title "${norm(doc.title)}")`);
  return { res, doc, actions: elementActions(doc.body || doc) };
}

// ---------------------------------------------------------------- A. Tender / NIT PDF

async function tenderPdf(run) {
  const r = newCategory('TENDER_PDF');
  const { ctx } = run;
  let req = allReqs(ctx.row.actions).find((x) => /viewNitPdf_[^/]*\.pdf/i.test(x.url));
  if (!req) {
    log('TenderPDF', 'No direct PDF action on the tender row; opening the View NIT page');
    const nit = await nitPage(run);
    req = allReqs(nit.actions).find((x) => /viewNitPdf_[^/]*\.pdf/i.test(x.url)) ||
      allReqs(nit.actions).find((x) => /download tender doc/i.test(x.action.label) && x.url);
  }
  if (!req) return failedCategory('TENDER_PDF', 'No Tender PDF action was found on the tender row or the View NIT page.');
  ctx.tenderPdfUrl = pathOf(req.url);
  ctx.discoveredActions.tenderPdf = [{ method: req.method, path: ctx.tenderPdfUrl }];
  log('TenderPDF', 'PDF action discovered');
  return downloadItems(run, r, [{ id: run.ids.nitId || '', req: { ...toRequest(req.url, req.method), relativeTo: ctx.searchUrl } }], (it) => ({
    req: it.req, subdir: 'NIT_and_Supporting_Documents', id: it.id, meta: { title: 'NIT / Tender document' }, fileName: () => `NIT_${safeSegment(ctx.tenderNo)}.pdf`,
  }));
}

// ---------------------------------------------------------------- B. Tender attachments

const LIST_HEADING = /list of documents attached with the tender/i;

/** Parse the "List of documents attached with the tender" table of a View NIT page. */
export function parseAttachmentRows(doc) {
  const all = [...doc.querySelectorAll('*')];
  const heading = all.find((e) => LIST_HEADING.test(norm(e.textContent)) && ![...e.children].some((c) => LIST_HEADING.test(norm(c.textContent))));
  if (!heading) return { found: false, rows: [] };
  const after = (a, b) => !!(a.compareDocumentPosition(b) & 4); // b follows a
  // the section ends at the next heading ("Corrigenda")
  const endMark = all.find((e) => after(heading, e) && !heading.contains(e) && !e.children.length && /^corrigend/i.test(norm(e.textContent)));
  const rowsOf = (t) => [...t.querySelectorAll('tr')].filter((tr) => !tr.querySelector('tr') && after(heading, tr) && (!endMark || after(tr, endMark)) && tr.querySelector('a,[onclick]'));
  const table = [...doc.querySelectorAll('table')].filter((t) => !t.querySelector('table')).find((t) => rowsOf(t).length);
  if (!table) return { found: true, rows: [] };
  const rows = [];
  for (const tr of rowsOf(table)) {
    if (tr.querySelector('th') || /^s\.?\s*no/i.test(norm(tr.textContent))) continue;
    const cells = [...tr.children].filter((c) => /^t[dh]$/i.test(c.tagName)).map((c) => norm(c.textContent));
    const acts = allReqs(elementActions(tr)).filter((x) => x.url && !/^(javascript:|#)/i.test(x.url));
    if (!acts.length) continue;
    rows.push({ cells, req: acts[0], name: norm(tr.querySelector('a')?.textContent) || cells[1] || '', description: cells.length > 2 ? cells[2] : '' });
  }
  return { found: true, rows };
}

const stemOf = (n) => String(n).replace(/\.[A-Za-z0-9]{2,5}$/, '');

async function attachments(run) {
  const r = newCategory('ATTACHMENTS');
  const { ctx } = run;
  const nit = await nitPage(run);
  const { found, rows } = parseAttachmentRows(nit.doc);
  log('Attachments', `Found ${rows.length} attachments (section ${found ? 'present' : 'absent'})`);
  if (!found) {
    const looksLikeNit = /download tender doc|tender no/i.test(norm(nit.doc.body?.textContent));
    if (!looksLikeNit) return failedCategory('ATTACHMENTS', `Unexpected page for View NIT (title "${norm(nit.doc.title)}"); attachments could not be listed.`);
    r.note = 'The View NIT page has no attached-documents section.';
    return finalize(r);
  }
  const items = rows.map((x, i) => ({
    id: stemOf(x.name), index: i + 1, name: x.name, description: x.description, meta: { name: x.name, description: x.description },
    req: { ...toRequest(x.req.url, x.req.method), relativeTo: nit.res.url },
  }));
  ctx.attachments = items.map((i) => ({ name: i.name, description: i.description }));
  ctx.discoveredActions.attachments = items.map((i) => ({ method: i.req.method, path: pathOf(i.req.url) }));
  return downloadItems(run, r, items, (it) => ({
    req: it.req, subdir: 'NIT_and_Supporting_Documents', id: it.id, meta: { title: [it.name, it.description].filter(Boolean).join(' - ') }, allowAnyFile: true, nameHint: it.name,
    fileName: (ext) => {
      const stem = safeSegment(stemOf(it.name), 60);
      const desc = it.description && norm(it.description).toLowerCase() !== norm(it.name).toLowerCase() ? safeSegment(stemOf(it.description), 60) : '';
      const base = desc && !desc.toLowerCase().includes(stem.toLowerCase()) ? `${desc}_${stem}` : stem;
      return `Attachment_${pad2(it.index)}_${base.replace(/\s+/g, '_')}${ext}`;
    },
  }));
}

// ---------------------------------------------------------------- C. Published corrigenda

/** Rows of the "View Published Corrigendum" list: showPubCorriDetail('<corrigendumId>','<cn>'). */
export function parseCorrigendumList(doc) {
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('[onclick],a[href]')) {
    const src = `${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`;
    const call = parseCalls(src).find((c) => /^showPubCorriDetail$/i.test(c.fn));
    if (!call) continue;
    const [corrigendumId, cn] = call.args;
    if (!corrigendumId || seen.has(`${corrigendumId}|${cn}`)) continue;
    seen.add(`${corrigendumId}|${cn}`);
    const cells = [...(el.closest('tr')?.children || [])].map((c) => norm(c.textContent)).filter(Boolean);
    items.push({
      id: corrigendumId, corrigendumId, cn, args: call.args,
      number: cells.find((c) => /corrigendum/i.test(c)) || '',
      publishedDate: cells.map((c) => DATE_RE.exec(c)?.[0]).find(Boolean) || '',
    });
  }
  // Only real showPubCorriDetail rows count. (Never scrape stray .pdf links: every IREPS page footer
  // carries About/Disclaimer/Privacy/Terms/Copyright PDFs.)
  return items;
}


// ---------------------------------------------------------------- corrigendum notices in the message inbox

export const todayStr = (d = new Date()) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

/**
 * "Issue of Corrigendum towards <unit>, Tender no: <no>" messages in My Messages > Inbox sent on `dateStr`
 * (default: today). These are notices only - the corrigendum document itself comes from the tender's
 * published list - but they tell us a corrigendum was issued today.
 */
/**
 * Read My Messages > Inbox (POST vendorInboxLink.do listType=MyMsg&pageNo=N, newest first) and return the
 * messages sent on any of `dates` (dd/mm/yyyy) whose subject `parse()` accepts.
 * Stops once a whole page is older than the earliest wanted date.
 */
export async function scanInbox(run, dates, parse) {
  const wanted = new Set(dates);
  const key = (d) => d.split('/').reverse().join('');
  const earliest = [...wanted].map(key).sort()[0];
  const out = [];
  let prevSig = '';
  for (let pageNo = 1; pageNo <= MAX_INBOX_PAGES; pageNo++) {
    const res = await irepsFetch(run.base, INBOX_PATH, { method: 'POST', form: { listType: 'MyMsg', pageNo: String(pageNo) } });
    assertSession(res);
    if (res.status !== 200) break;
    const doc = parseHtml(res.text());
    const rows = [...doc.querySelectorAll('tr')].filter((tr) => !tr.querySelector('tr') && /^\d{2}\/\d{2}\/\d{4}/.test(norm(tr.firstElementChild?.textContent)));
    const sig = rows.map((r) => norm(r.textContent)).join('\n');
    if (!rows.length || sig === prevSig) break;
    prevSig = sig;
    for (const tr of rows) {
      const date = norm(tr.firstElementChild.textContent).slice(0, 10);
      if (!wanted.has(date)) continue;
      const subject = norm(tr.querySelector('a[title]')?.getAttribute('title') || tr.textContent);
      const hit = parse(subject);
      if (hit) out.push({ date, subject, ...hit, messageOid: qparam(tr.innerHTML.match(/ViewMessageDetailAction\.do\?oid=\d+/)?.[0] || '', 'oid') });
    }
    if (rows.every((tr) => key(norm(tr.firstElementChild.textContent).slice(0, 10)) < earliest)) break;
  }
  return out;
}

const TENDER_AT_END = /tender\s*(?:no\.?|number)\s*:?\s*(\S+)\s*$/i;

/** "Issue of Corrigendum towards <unit>, Tender no: X" notices sent on `dateStr` (default today); optional tender filter. */
export async function findCorrigendumNotices(run, { tenderNo = null, dateStr = todayStr() } = {}) {
  return scanInbox(run, [dateStr], (subject) => {
    const m = /corrigendum/i.test(subject) && TENDER_AT_END.exec(subject);
    if (!m) return null;
    if (tenderNo && norm(m[1]).toLowerCase() !== norm(tenderNo).toLowerCase()) return null;
    return { tenderNo: m[1] };
  });
}

/** "NIT for <dept/unit>, Tender Number: X" notices sent on any of `dates`. */
export async function findNitNotices(run, dates) {
  return scanInbox(run, dates, (subject) => {
    const m = /^NIT for\b/i.test(subject) && TENDER_AT_END.exec(subject);
    return m ? { tenderNo: m[1] } : null;
  });
}

async function corrigenda(run) {
  const r = newCategory('CORRIGENDA');
  const { ctx } = run;
  const list = allReqs(ctx.row.actions).find((x) => /viewCorrigendum\.do/i.test(pathOf(x.url)));
  if (!list) {
    log('Corrigendum', 'Found 0 published corrigenda (no action on the tender row)');
    r.note = 'The tender row has no Published Corrigendum action.';
    return finalize(r);
  }
  noteIds(run, list.url, 'row_action');
  ctx.discoveredActions.corrigenda = [{ method: list.method, path: pathOf(list.url) }];
  const res = await irepsFetch(run.base, list.url, { method: list.method, relativeTo: ctx.searchUrl });
  assertSession(res);
  const doc = parseHtml(res.text());
  const items = parseCorrigendumList(doc);
  log('Corrigendum', `Found ${items.length} published corrigenda (page "${norm(doc.title)}", HTTP ${res.status})`);
  if (res.status !== 200 || (!items.length && !/corrigendum/i.test(norm(doc.title)))) {
    return failedCategory('CORRIGENDA', `Unexpected response for the corrigendum list (HTTP ${res.status}, title "${norm(doc.title)}").`);
  }
  if (!items.length) {
    // nothing published in the list: look for a corrigendum notice sent to the inbox today
    try {
      const notices = await findCorrigendumNotices(run, { tenderNo: ctx.tenderNo });
      log('Corrigendum', `Inbox notices dated today: ${notices.length}`);
      if (notices.length) {
        r.note = 'The inbox has a corrigendum notice for this tender dated today, but IREPS does not list a published corrigendum yet. Try again later.';
      }
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED') throw e;
      log('Corrigendum', `inbox notice check failed: ${e.message}`);
    }
    return finalize(r);
  }
  ctx.corrigenda = items.map((i) => ({ number: i.number, cn: i.cn, publishedDate: i.publishedDate }));
  const wantDate = (d) => (run.dateRange ? run.dateRange.has(d) : run.onlyDate ? d === run.onlyDate : true);
  if (run.onlyDate || run.dateRange) {
    // date-based runs: just the corrigenda published in the selected range, not the tender's older ones
    const todays = items.filter((i) => wantDate(i.publishedDate));
    log('Corrigendum', `${todays.length} of ${items.length} listed corrigenda fall in the selected date(s)`);
    if (!todays.length) {
      r.note = `The list has no corrigendum dated ${run.onlyDate || 'in the selected range'} yet.`;
      return finalize(r);
    }
    items.splice(0, items.length, ...todays);
  }

  const scripts = inlineScripts(doc);
  for (const it of items) {
    if (it.direct) {
      it.req = { ...toRequest(it.direct.url, it.direct.method), relativeTo: res.url };
      continue;
    }
    const route = inferRoute(scripts, 'showPubCorriDetail', it.args);
    if (!route) {
      it.skip = { code: 'NO_ROUTE', message: 'Could not read the corrigendum detail route from the IREPS page.' };
      continue;
    }
    it.req = { ...toRequest(route.url, route.method), relativeTo: res.url };
  }
  return downloadItems(run, r, items, (it) => ({
    req: it.req, subdir: 'Corrigenda', id: it.id, meta: { title: it.number, docDate: it.publishedDate }, allowHtml: true, allowAnyFile: true,
    fileName: (ext) => `Corrigendum_${pad2(parseInt(it.cn, 10) || items.indexOf(it) + 1)}_${safeSegment(ctx.tenderNo)}${ext}`,
  }));
}

// ---------------------------------------------------------------- D. My Offer

async function myOffer(run) {
  const r = newCategory('MY_OFFER');
  const { ctx } = run;
  const offer = allReqs(ctx.row.actions).find((x) => /commTboPdfAction\.do/i.test(pathOf(x.url)) && /^offer$/i.test(qparam(x.url, 'pdfType')));
  log('MyOffer', `Checking offer action: ${offer ? 'found' : 'not present'}`);
  if (!offer) {
    r.note = 'No My Offer action is shown for this tender (it appears on the tender row once you have submitted an offer).';
    return finalize(r);
  }
  setId(run, 'tenderOID', qparam(offer.url, 'tenderOID'), 'row_action');
  ctx.discoveredActions.myOffer = [{ method: offer.method, path: pathOf(offer.url) }];
  const acct = qparam(offer.url, 'accountID');
  const item = { id: qparam(offer.url, 'tenderOID'), req: { ...toRequest(offer.url, offer.method), relativeTo: ctx.searchUrl } };
  if (acct && acct !== run.account.irepsAccountId) {
    item.skip = { code: 'ACCOUNT_MISMATCH', message: `Account mismatch: this offer belongs to account ${acct} but the active account is ${run.account.irepsAccountId}.` };
  }
  return downloadItems(run, r, [item], (it) => ({
    req: it.req, subdir: 'My_Offer', id: it.id, meta: { title: 'My Offer' }, fileName: () => `My_Offer_${safeSegment(ctx.tenderNo)}.pdf`,
  }));
}

// ---------------------------------------------------------------- D2. Financial / Commercial Tabulation

/**
 * The tabulations sit next to My Offer on commTboPdfAction.do (pdfType=...), on the tender's row in IREPS
 * "Closed Tenders" (Vendor inbox, Tenders > Closed Tenders, filtered by closing date) once the bids are opened:
 *   View Financial Tabulation   /epsn/tbo/commTboPdfAction.do?tenderOID=<oid>&pdfType=financialTabulation&accountID=<acct>
 *   View Commercial Tabulation  /epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=<oid>&accountID=<acct>
 * (01_api_data/finncial and commercial documentation response.har). Both open with postRequestNewWindow (POST).
 */
export const TABULATIONS = Object.freeze({
  financialTabulation: { pdfType: 'financialTabulation', category: 'FINANCIAL_TABULATION', key: 'financialTabulation', label: 'Financial Tabulation', file: 'Financial_Tabulation' },
  commercialTabulation: { pdfType: 'commercialTabulation', category: 'COMMERCIAL_TABULATION', key: 'commercialTabulation', label: 'Commercial Tabulation', file: 'Commercial_Tabulation' },
});
const CLOSED_STATUS = 'MyBidsClosed';
const CLOSED_WINDOW_DAYS = 90; // the Closed Tenders page's own default range
const CLOSING_RE = /^(\d{2}\/\d{2}\/\d{4})(?:\s+\d{1,2}:\d{2})?$/;
/** "23/10/2026 11:30" or "23/10/2026" -> that day (local), or null. */
const closingDay = (text) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(norm(text));
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
};

const tabulationReq = (actions, pdfType) =>
  allReqs(actions).find((x) => /commTboPdfAction\.do/i.test(pathOf(x.url)) && qparam(x.url, 'pdfType').toLowerCase() === pdfType.toLowerCase()) || null;

/**
 * The rows of a Closed Tenders page:
 *   Dept/Rly. Unit | Tender No. (Bid Id) | Tender Title | Closing Date/Time | Actions
 * -> [{ tenderNo, bidId, nitId, tenderOid, dept, title, closingDate, links: { financialTabulation, commercialTabulation } }]
 * A link is the request ({ method, url }) or null when IREPS does not show it (yet).
 */
export function parseClosedTenders(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('tr')) {
    if (tr.querySelector('tr')) continue;
    const nitLink = [...tr.querySelectorAll('a')].find((a) => /nitPublish\.do/i.test(`${a.getAttribute('onclick') || ''} ${a.getAttribute('href') || ''}`) && norm(a.textContent));
    if (!nitLink) continue;
    const cells = [...tr.children].filter((c) => /^td$/i.test(c.tagName));
    const at = cells.indexOf(nitLink.closest('td'));
    const text = (i) => (i >= 0 && i < cells.length ? norm(cells[i].textContent) : '');
    const actions = elementActions(tr);
    const reqs = allReqs(actions);
    const closing = cells.map((c) => norm(c.textContent)).find((t) => CLOSING_RE.test(t)) || '';
    rows.push({
      tenderNo: norm(nitLink.textContent),
      bidId: /\((\d+)\)/.exec(text(at))?.[1] || '',
      nitId: reqs.map((x) => qparam(x.url, 'nitId')).find(Boolean) || '',
      tenderOid: reqs.map((x) => qparam(x.url, 'tenderOID') || qparam(x.url, 'oid') || qparam(x.url, 'nitOid')).find(Boolean) || '',
      dept: text(at - 1),
      title: text(at + 1),
      closingDate: closing,
      links: Object.fromEntries(Object.keys(TABULATIONS).map((t) => [t, tabulationReq(actions, t)])),
    });
  }
  return rows;
}

/** [from, to] (Dates, both included) in windows of at most CLOSED_WINDOW_DAYS days. */
function closingWindows(from, to) {
  const day = 86400000;
  const out = [];
  for (let start = new Date(from.getFullYear(), from.getMonth(), from.getDate()); start <= to; ) {
    const end = new Date(Math.min(start.getTime() + (CLOSED_WINDOW_DAYS - 1) * day, to.getTime()));
    out.push({ from: start, to: end });
    start = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  return out;
}

/**
 * Read IREPS Closed Tenders for tenders CLOSING between `from` and `to` (Dates), optionally one tender
 * number, across windows and result pages. -> { rows (see parseClosedTenders), pages }
 */
export async function scanClosedTenders(run, { from, to, tenderNo = '' }) {
  const form = await loadInboxForm(run, CLOSED_STATUS, 'Tenders');
  const sample = form.defaults.get('startDate') || form.defaults.get('endDate') || '';
  const rows = [];
  const seen = new Set();
  let pages = 0;
  for (const win of closingWindows(from, to)) {
    let prevSig = '';
    for (let pageNo = 1; pageNo <= MAX_INBOX_PAGES; pageNo++) {
      const p = new URLSearchParams(form.defaults);
      Object.entries({ menuLink: 'Tenders', status: CLOSED_STATUS, listType: CLOSED_STATUS, tenderNo, startDate: fmtDate(win.from, sample), endDate: fmtDate(win.to, sample), pageNo: String(pageNo) })
        .forEach(([k, v]) => p.set(k, v));
      const res = await irepsFetch(run.base, form.action, { method: 'POST', form: p, relativeTo: form.pageUrl || undefined });
      assertSession(res);
      if (res.status !== 200) throw new TenderError('HTTP', `IREPS returned HTTP ${res.status} for the Closed Tenders list.`);
      pages++;
      const doc = parseHtml(res.text());
      const found = parseClosedTenders(doc);
      const sig = found.map((r) => `${r.tenderNo}|${r.bidId}`).join(',');
      if (!found.length || sig === prevSig) break;
      prevSig = sig;
      for (const r of found) {
        const k = `${r.tenderNo}|${r.bidId}`;
        if (!seen.has(k)) { seen.add(k); rows.push({ ...r, pageUrl: res.url }); }
      }
      if (!hasMorePages(doc, pageNo)) break;
    }
  }
  log('Closed', `${rows.length} closed tender(s) over ${pages} page(s), ${rows.filter((r) => r.links.financialTabulation || r.links.commercialTabulation).length} with a tabulation`);
  return { rows, pages };
}

/** This tender's Closed Tenders row (one scan per run, shared by both tabulation steps), or null. */
function closedTenderRow(run) {
  if (!run.closedRowP) {
    const day = 86400000;
    const closing = closingDay(run.ctx.closingDate || '');
    const now = new Date();
    // around the known closing date, else the page's own last 90 days
    const [from, to] = closing ? [new Date(closing.getTime() - day), new Date(closing.getTime() + day)] : [new Date(now.getTime() - (CLOSED_WINDOW_DAYS - 1) * day), now];
    run.closedRowP = scanClosedTenders(run, { from, to, tenderNo: run.ctx.tenderNo }).then(({ rows }) => {
      const want = norm(run.ctx.tenderNo).toLowerCase();
      return rows.find((r) => norm(r.tenderNo).toLowerCase() === want) || null;
    });
  }
  return run.closedRowP;
}

/** Download one tabulation from its request (a tender row or a Closed Tenders row): one category result. */
export function downloadTabulation(run, pdfType, rq, { relativeTo = '' } = {}) {
  const t = TABULATIONS[pdfType];
  const r = newCategory(t.category);
  const { ctx } = run;
  const oid = qparam(rq.url, 'tenderOID');
  setId(run, 'tenderOID', oid, 'row_action');
  ctx.discoveredActions[t.key] = [{ method: rq.method, path: pathOf(rq.url) }];
  const acct = qparam(rq.url, 'accountID');
  const item = { id: oid || ctx.tenderNo, req: { ...toRequest(rq.url, rq.method), relativeTo: relativeTo || ctx.searchUrl } };
  if (acct && acct !== run.account.irepsAccountId) {
    item.skip = { code: 'ACCOUNT_MISMATCH', message: `Account mismatch: this ${t.label} belongs to account ${acct} but the active account is ${run.account.irepsAccountId}.` };
  }
  // a PDF is expected (as for My Offer); a web page answer is printed to PDF like the letters
  return downloadItems(run, r, [item], (it) => ({
    req: it.req, subdir: 'Tabulation', id: it.id, meta: { title: t.label }, allowHtml: true, print: true,
    fileName: (ext) => `${t.file}_${safeSegment(ctx.tenderNo)}${ext}`,
  }));
}

async function tabulation(run, pdfType) {
  const t = TABULATIONS[pdfType];
  let rq = tabulationReq(run.ctx.row.actions, pdfType);
  let relativeTo = '';
  if (!rq) {
    const row = await closedTenderRow(run);
    rq = row?.links[pdfType] || null;
    relativeTo = row?.pageUrl || '';
  }
  log('Tabulation', `${t.label}: ${rq ? 'found' : 'not shown'}`);
  if (!rq) {
    const r = newCategory(t.category);
    r.note = `IREPS shows no ${t.label} for this tender yet (it appears under Closed Tenders once the bids are opened).`;
    return finalize(r);
  }
  return downloadTabulation(run, pdfType, rq, { relativeTo });
}
const financialTabulation = (run) => tabulation(run, 'financialTabulation');
const commercialTabulation = (run) => tabulation(run, 'commercialTabulation');

// ---------------------------------------------------------------- Post Tenders (inbox) lists

function hasMorePages(doc, pageNo) {
  for (const el of doc.querySelectorAll('a,input[type=button],input[type=submit],button,[onclick]')) {
    const t = norm(el.textContent || el.getAttribute('value') || '');
    const oc = el.getAttribute('onclick') || '';
    if (/^(next|>|>>|›|»)$/i.test(t) || /nextpage|gotopage|pageno/i.test(oc)) return true;
    if (t === String(pageNo + 1)) return true;
  }
  return false;
}

/**
 * Negotiation and Counter Offer pages are often very slow to open on IREPS. Their requests get up to
 * fetchSettings.waitMs (3 minutes) instead of the usual 45 seconds, retrying while IREPS cannot be reached.
 */
const WAIT_FOR_PAGE = new Set(['MyNegotiation', 'MyCounterOffer']);
function pageWait(run, status) {
  if (!WAIT_FOR_PAGE.has(status)) return null;
  return { what: `${LETTER_KINDS[status].page} page`, onWait: (msg) => run.onProgress?.(msg) };
}

async function loadInboxForm(run, status, menuLink = 'PostTenders') {
  // Post Tenders lists open on menuLink + status; the Tenders lists (Closed Tenders) also name their listType
  const first = menuLink === 'PostTenders' ? { menuLink, status } : { menuLink, status, listType: status };
  for (const method of ['POST', 'GET']) {
    const g = await irepsFetch(run.base, INBOX_PATH, { method, form: first, wait: pageWait(run, status) });
    assertSession(g);
    if (g.status !== 200) continue;
    const gdoc = parseHtml(g.text());
    const f = findForm(gdoc, (x) => x.querySelector('[name=tenderNo]'));
    if (f) return { defaults: formParams(f), action: f.getAttribute('action') || INBOX_PATH, scripts: inlineScripts(gdoc), pageUrl: g.url };
  }
  return { defaults: new URLSearchParams(), action: INBOX_PATH, scripts: '', pageUrl: '' };
}

function inboxWindows(defaults, today = new Date()) {
  const sample = defaults.get('startDate') || defaults.get('endDate') || '';
  const wins = [];
  if (defaults.get('startDate') && defaults.get('endDate')) wins.push({ startDate: defaults.get('startDate'), endDate: defaults.get('endDate') });
  for (let i = 0; wins.length < INBOX_WINDOWS; i++) {
    const end = new Date(today.getTime() - i * INBOX_WINDOW_DAYS * 86400000);
    const start = new Date(end.getTime() - INBOX_WINDOW_DAYS * 86400000);
    const w = { startDate: fmtDate(start, sample), endDate: fmtDate(end, sample) };
    if (!wins.some((x) => x.startDate === w.startDate && x.endDate === w.endDate)) wins.push(w);
  }
  return wins;
}

/** All rows for the exact tender in a Post Tenders list, across date windows and result pages. */
function inbox(run, status) {
  // cached as a promise so parallel steps share one scan of the same list
  if (!run.inboxCache.has(status)) {
    run.inboxCache.set(status, scanInboxRows(run, status).catch((e) => { run.inboxCache.delete(status); throw e; }));
  }
  return run.inboxCache.get(status);
}

async function scanInboxRows(run, status) {
  const entry = { status, rows: [], scripts: '', windows: 0, pages: 0 };
  const form = await loadInboxForm(run, status);
  entry.scripts = form.scripts;
  const seenRows = new Set();
  const visited = new Set();

  for (const win of inboxWindows(form.defaults)) {
    entry.windows++;
    let prevSig = '';
    for (let pageNo = 1; pageNo <= MAX_INBOX_PAGES; pageNo++) {
      const p = new URLSearchParams(form.defaults);
      p.set('menuLink', 'PostTenders');
      p.set('status', status);
      p.set('tenderNo', run.ctx.tenderNo);
      p.set('startDate', win.startDate);
      p.set('endDate', win.endDate);
      if (!p.get('raStatus')) p.set('raStatus', '-1');
      p.set('pageNo', String(pageNo));
      p.set('listType', status);
      const pageKey = `${win.startDate}|${win.endDate}|${pageNo}`;
      if (visited.has(pageKey)) break;
      visited.add(pageKey);

      const res = await irepsFetch(run.base, form.action, { method: 'POST', form: p, relativeTo: form.pageUrl || undefined, wait: pageWait(run, status) });
      assertSession(res);
      if (res.status !== 200) break;
      entry.pages++;
      const doc = parseHtml(res.text());
      entry.scripts += '\n' + inlineScripts(doc);
      const leaf = [...doc.querySelectorAll('tr')].filter((tr) => !tr.querySelector('tr') && tr.querySelector('a,[onclick]'));
      const sig = leaf.map((t) => norm(t.outerHTML)).join('\n'); // markup, so rows that differ only in link params still differ
      if (!leaf.length || sig === prevSig) break;
      prevSig = sig;
      let hits = findTenderRows(doc, run.ctx.tenderNo);
      if (!hits.length) hits = findTenderRowsLoose(doc, run.ctx.tenderNo);
      for (const tr of hits) {
        const actions = elementActions(tr);
        const k = actions.map((a) => a.urls.join(',') + a.onclick).join('|');
        if (seenRows.has(k)) continue;
        seenRows.add(k);
        for (const a of actions) for (const u of a.urls) noteIds(run, u, 'inbox');
        entry.rows.push({ actions, html: tr.outerHTML, text: norm(tr.textContent) });
      }
      if (!hasMorePages(doc, pageNo)) break;
    }
  }
  log('Inbox', `${status}: ${entry.rows.length} matching row(s) over ${entry.windows} date window(s), ${entry.pages} page(s)`);
  return entry;
}

/** Published-letter requests (method taken from how the page issues them). */
function letterItems(entry, pathRe, idParam, accept = () => true) {
  const items = [];
  for (const row of entry.rows) {
    for (const rq of allReqs(row.actions)) {
      if (!pathRe.test(pathOf(rq.url)) || !accept(rq)) continue;
      items.push({ id: qparam(rq.url, idParam) || `${items.length + 1}`, rq, url: rq.url, text: row.text, date: LETTER_STAMP_RE.exec(row.text)?.[1] || '' });
    }
  }
  return items;
}

/** How each Post Tenders list exposes its published-letter action. */
export const LETTER_SPECS = {
  MyNegotiation: { key: 'negotiation', re: /publishIndiNegotiationLetter\.do/i, idParam: 'negoLetterId', accept: (x) => /ViewPublishedLetter/i.test(qparam(x.url, 'opValue')) },
  MyCounterOffer: { key: 'counterOffer', re: /publishCounterOfferLetter\.do/i, idParam: 'letterId', accept: (x) => /ViewPublishedLetter/i.test(qparam(x.url, 'Action')) },
  MyAdvanceAcceptanceLetter: { key: 'loa', re: /publishLOALetter\.do/i, idParam: 'letterId', accept: (x) => /ViewPublishedLetter/i.test(qparam(x.url, 'Action')) },
};

/** "10/09/2026 17:40 (224222)" - the letter's published date/time and id, as shown in the Post Tenders rows. */
const LETTER_STAMP_RE = /(\d{2}\/\d{2}\/\d{4})\s+\d{1,2}:\d{2}\s*\((\d+)\)/;
const LETTER_STAMP = /(\d{2}\/\d{2}\/\d{4})\s+\d{1,2}:\d{2}\s*\((\d+)\)/;

/**
 * Read a Post Tenders list with the tender number left blank, over the given CLOSING-date windows
 * ([fromDays,toDays] relative to today; IREPS's own range is 90 days). The lists are filtered by closing
 * date, but each row also carries the letter's own published date, which is what the date-based jobs use.
 *   -> { entries: [{ tenderNo, id, date, rq, url }], scripts, unparsed }
 */
export async function scanPostTenderList(run, status, { windows = [[-90, 0], [0, 90]] } = {}) {
  const spec = LETTER_SPECS[status];
  const form = await loadInboxForm(run, status);
  const sample = form.defaults.get('startDate') || '';
  const day = 86400000;
  const now = Date.now();
  const wins = windows.map(([a, b]) => ({ startDate: fmtDate(new Date(now + a * day), sample), endDate: fmtDate(new Date(now + b * day), sample) }));
  const entries = [];
  const seen = new Set();
  let unparsed = 0;
  let scripts = form.scripts;
  for (const win of wins) {
    let prevSig = '';
    for (let pageNo = 1; pageNo <= MAX_INBOX_PAGES; pageNo++) {
      const p = new URLSearchParams(form.defaults);
      Object.entries({ menuLink: 'PostTenders', status, tenderNo: '', startDate: win.startDate, endDate: win.endDate, pageNo: String(pageNo), listType: status }).forEach(([k, v]) => p.set(k, v));
      if (!p.get('raStatus')) p.set('raStatus', '-1');
      const res = await irepsFetch(run.base, form.action, { method: 'POST', form: p, wait: pageWait(run, status) });
      assertSession(res);
      if (res.status !== 200) break;
      const doc = parseHtml(res.text());
      scripts += '\n' + inlineScripts(doc);
      const leaf = [...doc.querySelectorAll('tr')].filter((tr) => !tr.querySelector('tr') && tr.querySelector('a,[onclick]'));
      log('Inbox', `${status} ${win.startDate}..${win.endDate} page ${pageNo}: ${leaf.length} row(s), title "${norm(doc.title)}"${leaf.length ? '' : `, text "${norm(doc.body?.textContent).slice(0, 100)}"`}`);
      const sig = leaf.map((t) => norm(t.outerHTML)).join('\n');
      if (!leaf.length || sig === prevSig) break;
      prevSig = sig;
      for (const tr of leaf) {
        const letters = allReqs(elementActions(tr)).filter((x) => spec.re.test(pathOf(x.url)) && spec.accept(x));
        if (!letters.length) continue;
        const tenderNo = norm(tr.querySelector('a[title*="NIT" i]')?.textContent) || norm(tr.querySelector('a')?.textContent);
        const stamp = LETTER_STAMP.exec(norm(tr.textContent));
        if (!tenderNo || !stamp) { unparsed++; continue; }
        for (const rq of letters) {
          const id = qparam(rq.url, spec.idParam) || stamp[2];
          if (seen.has(`${tenderNo}|${id}`)) continue;
          seen.add(`${tenderNo}|${id}`);
          entries.push({ tenderNo, id, date: stamp[1], rq, url: rq.url });
        }
      }
      if (!hasMorePages(doc, pageNo)) break;
    }
  }
  log('Inbox', `${status}: ${entries.length} letter(s) listed${unparsed ? `, ${unparsed} row(s) without a readable date/tender` : ''}`);
  return { entries, scripts, unparsed };
}

// ---------------------------------------------------------------- E/F/G. Negotiation, Counter offer, LOA letters

function bidderMismatch(run, url) {
  const bidder = qparam(url, 'bidderAccId');
  if (bidder && bidder !== run.account.irepsAccountId) {
    return { code: 'ACCOUNT_MISMATCH', message: `Account mismatch: this letter is for bidder account ${bidder} but the active account is ${run.account.irepsAccountId}.` };
  }
  return null;
}

export const LETTER_KINDS = {
  MyNegotiation: { category: 'NEGOTIATION', tag: 'Negotiation', subdir: 'Negotiation', file: 'Negotiation', page: 'Negotiation' },
  MyCounterOffer: { category: 'COUNTER_OFFER', tag: 'CounterOffer', subdir: 'Counter_Offers', file: 'Counter_Offer', page: 'Counter Offer' },
  MyAdvanceAcceptanceLetter: { category: 'LOA', tag: 'LOA', subdir: 'Advance_Acceptance_LOA', file: 'LOA', page: 'Advance Acceptance Letter' },
};

/**
 * Download published letters of one Post Tenders list, given the items found in that list
 * (items: { id, rq:{method,url,args}, url }). `scripts` is the list page's inline JS (for the LOA helper).
 *   Negotiation: View Negotiation Letters only ("Nego Bid Process" is never requested)
 *   Counter offer: the published letter only; coResponse.do (the response page) is never requested
 *   LOA: mirrors loaLetterViewActivity - the letter is requested only after the preliminary call answers "OK"
 */
export async function downloadLetterItems(run, status, items, scripts = '') {
  const kind = LETTER_KINDS[status];
  const r = newCategory(kind.category);
  const { ctx } = run;
  log(kind.tag, `Found ${items.length} matching letters`);

  let prefix = '';
  let loaAck = null;
  if (status === 'MyAdvanceAcceptanceLetter') {
    const fnAt = scripts.search(/function\s+loaLetterViewActivity/i);
    const fn = fnAt >= 0 ? scripts.slice(fnAt, fnAt + 2500) : '';
    prefix = /['"](\/[\w/]+)['"]\s*\+\s*url/.exec(fn)?.[1] || (fnAt < 0 ? '/epsn' : '');
    loaAck = {
      path: /getAjaxData\s*=\s*['"]([^'"]+)['"]/.exec(fn)?.[1] || DEFAULT_AJAX_PATH,
      ajaxMode: /ajaxMode\s*:\s*["']([^"']+)["']/.exec(fn)?.[1] || 'updateLoaViewedDataByBidder',
      docType: /docType\s*=\s*["'](\d+)["']/.exec(fn)?.[1] || '11',
    };
  }
  for (const it of items) noteIds(run, it.url, 'inbox'); // nitOId etc. straight from the live letter action
  ctx.discoveredActions[LETTER_SPECS[status].key] = items.map((i) => ({ method: loaAck ? 'POST' : i.rq.method, path: prefix + pathOf(i.url) }));
  for (const it of items) {
    it.req = { ...toRequest(it.url, loaAck ? 'POST' : it.rq.method, { prefix }), relativeTo: ctx.searchUrl, wait: pageWait(run, status) };
    if (status !== 'MyNegotiation') it.skip = bidderMismatch(run, it.url);
    if (loaAck) it.docId = it.rq.args?.[1] || qparam(it.url, 'letterId');
  }
  // print: IREPS builds every published letter as a web page on each view; Chrome prints it to PDF as Ctrl+P does
  return downloadItems(run, r, items, (it) => ({
    req: it.req, subdir: kind.subdir, id: it.id, meta: { title: `${kind.tag} letter ${it.id}`, docDate: it.date || '' }, allowHtml: true, allowAnyFile: true, print: true,
    before: loaAck && (async () => {
      const ack = await irepsFetch(run.base, loaAck.path, { method: 'POST', form: { ajaxMode: loaAck.ajaxMode, docId: it.docId, docType: loaAck.docType } });
      assertSession(ack);
      const body = ack.text().trim();
      if (ack.status !== 200 || body !== 'OK') {
        log('LOA', `Preliminary request failed (HTTP ${ack.status}, response "${body.slice(0, 40)}")`);
        throw new TenderError('LOA_ACK', `IREPS did not confirm the LOA view update (HTTP ${ack.status}, response "${body.slice(0, 40)}"); the letter was not requested.`);
      }
    }),
    fileName: (ext) => `${kind.file}_${safeSegment(ctx.tenderNo)}_${safeSegment(it.id)}${ext}`,
  }));
}

async function letterCategory(run, status) {
  const entry = await inbox(run, status);
  const sp = LETTER_SPECS[status];
  return downloadLetterItems(run, status, letterItems(entry, sp.re, sp.idParam, sp.accept), entry.scripts);
}
const negotiation = (run) => letterCategory(run, 'MyNegotiation');
const counterOffer = (run) => letterCategory(run, 'MyCounterOffer');
const loa = (run) => letterCategory(run, 'MyAdvanceAcceptanceLetter');

// ---------------------------------------------------------------- H. Tender-related correspondence

function pageTenderNo(doc) {
  for (const c of doc.querySelectorAll('td')) {
    if (c.children.length === 0 && /^tender\s*no\.?$/i.test(norm(c.textContent))) {
      const v = norm(c.nextElementSibling?.textContent);
      if (v) return v;
    }
  }
  return '';
}

/** The tender's "Closing Date" as the correspondence page prints it beside the Tender No, or ''. */
export function pageClosingDate(doc) {
  for (const c of doc.querySelectorAll('td')) {
    if (c.children.length === 0 && /^closing\s*date$/i.test(norm(c.textContent))) {
      const v = norm(c.nextElementSibling?.textContent);
      if (v) return v;
    }
  }
  return '';
}

/** nitOid for the correspondence page: inbox rows first, then the correspondence list, then the tender row's oid. */
function ensureNitOid(run) {
  if (run.ids.nitOid) return Promise.resolve(run.ids.nitOid);
  if (!run.nitOidP) run.nitOidP = findNitOid(run).finally(() => { run.nitOidP = null; });
  return run.nitOidP;
}

async function findNitOid(run) {
  try {
    const res = await irepsFetch(run.base, CORRES_LIST_PATH, { method: 'POST', form: {} });
    assertSession(res);
    if (res.status === 200) {
      const doc = parseHtml(res.text());
      let rows = findTenderRows(doc, run.ctx.tenderNo);
      if (!rows.length) rows = findTenderRowsLoose(doc, run.ctx.tenderNo);
      for (const tr of rows) for (const a of elementActions(tr)) for (const u of a.urls) noteIds(run, u, 'correspondence_list');
    }
  } catch (e) {
    if (e.code === 'SESSION_EXPIRED') throw e;
    log('Correspondence', `list lookup failed: ${e.message}`);
  }
  if (!run.ids.nitOid) {
    // Last resort: the tender row's own "oid" (Bid Process / payment actions) - the same value the
    // inbox letters carry as nitOId. Logged as lower confidence; the page's Tender No is re-checked below.
    const oid = allReqs(run.ctx.row.actions).map((x) => qparam(x.url, 'oid')).find(Boolean);
    if (oid) setId(run, 'nitOid', oid, 'row_oid');
  }
  return run.ids.nitOid;
}

async function correspondence(run) {
  const r = newCategory('CORRESPONDENCE');
  const { ctx } = run;
  const nitOid = await ensureNitOid(run);
  if (!nitOid) {
    log('Correspondence', 'Found 0 matching letters (no nitOid could be discovered)');
    r.note = 'No nitOid could be discovered for this tender, so the correspondence page could not be opened.';
    return finalize(r);
  }
  ctx.discoveredActions.correspondence = [{ method: 'POST', path: CORRES_PATH }];
  const res = await irepsFetch(run.base, CORRES_PATH, { method: 'POST', form: { nitOid } });
  assertSession(res);
  const doc = parseHtml(res.text());
  const onPage = pageTenderNo(doc);
  if (res.status !== 200) return failedCategory('CORRESPONDENCE', `Correspondence page returned HTTP ${res.status}.`);
  if (onPage && norm(onPage).toLowerCase() !== norm(ctx.tenderNo).toLowerCase()) {
    log('Correspondence', 'nitOid belongs to a different tender; discarded');
    return failedCategory('CORRESPONDENCE', `The correspondence page is for tender ${onPage}, not ${ctx.tenderNo}; nothing was downloaded.`);
  }
  if (!onPage) log('Correspondence', 'Tender No not found on the correspondence page; cannot cross-check');
  // the ECM's tender date: runs that did not search the tender (letters by date) learn it here
  if (!ctx.closingDate) ctx.closingDate = pageClosingDate(doc);

  const scripts = inlineScripts(doc);
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('[onclick],a[href]')) {
    const call = parseCalls(`${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''}`).find((c) => /^viewPublishedLtr$/i.test(c.fn));
    if (!call) continue;
    const [oid, corresId, letterId] = call.args;
    if (!letterId || seen.has(`${corresId}|${letterId}`)) continue;
    seen.add(`${corresId}|${letterId}`);
    const cells = [...(el.closest('tr')?.children || [])].map((c) => norm(c.textContent)).filter(Boolean);
    const route = inferRoute(scripts, 'viewPublishedLtr', call.args);
    const target = route || { method: 'POST', url: `${CORRES_VIEW_FALLBACK}?nitOid=${oid}&letterID=${letterId}&corresId=${corresId}` };
    if (!route) log('Correspondence', 'Route not readable from the page; using the documented viewpubIndltr.do route');
    items.push({
      id: letterId, corresId, letterId, nitOid: oid || nitOid, letterNo: cells[0] || '', subject: cells[1] || '',
      letterDate: /dated\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(cells[0] || '')?.[1] || '',
      req: { ...toRequest(target.url, target.method), relativeTo: res.url },
    });
  }
  if (run.dateRange) {
    // the correspondence page has no date filter of its own: apply the selected range to each letter's date
    const keep = items.filter((i) => i.letterDate && run.dateRange.has(i.letterDate));
    log('Correspondence', `${keep.length} of ${items.length} letters are dated in the selected range`);
    items.splice(0, items.length, ...keep);
  }
  log('Correspondence', `Found ${items.length} matching letters`);
  return downloadItems(run, r, items, (it) => ({
    // viewpubIndltr.do only - vendorCorresSubmitReply.do is for replying and is never requested
    req: it.req, subdir: 'Correspondence', id: it.id, meta: { title: it.subject || `Correspondence ${it.letterNo}`, docDate: it.letterDate || '' }, allowHtml: true, allowAnyFile: true, print: true,
    fileName: (ext) => `Correspondence_${safeSegment(ctx.tenderNo)}_${safeSegment(it.letterId)}${ext}`,
  }));
}

// ---------------------------------------------------------------- master flow

const STEPS = [
  ['tenderPdf', 'Downloading Tender document...', tenderPdf],
  ['attachments', 'Downloading Tender attachments...', attachments],
  ['corrigenda', 'Downloading Published Corrigenda...', corrigenda],
  ['myOffer', 'Checking My Offer...', myOffer],
  ['negotiation', 'Checking Negotiation Letters...', negotiation],
  ['counterOffer', 'Checking Counter Offer Letters...', counterOffer],
  ['loa', 'Checking Advance Acceptance / LOA...', loa],
  ['correspondence', 'Checking Tender Correspondence...', correspondence],
  ['financialTabulation', 'Checking Financial Tabulation...', financialTabulation],
  ['commercialTabulation', 'Checking Commercial Tabulation...', commercialTabulation],
];

const TYPE = { tenderPdf: 'TENDER_PDF', attachments: 'ATTACHMENTS', corrigenda: 'CORRIGENDA', myOffer: 'MY_OFFER', negotiation: 'NEGOTIATION', counterOffer: 'COUNTER_OFFER', loa: 'LOA', correspondence: 'CORRESPONDENCE', financialTabulation: 'FINANCIAL_TABULATION', commercialTabulation: 'COMMERCIAL_TABULATION' };

export function summarize(categories) {
  const cats = CATEGORY_KEYS.filter((k) => categories[k]).map((k) => categories[k]);
  return {
    totalDiscovered: cats.reduce((n, c) => n + c.discovered, 0),
    downloaded: cats.reduce((n, c) => n + c.downloaded, 0),
    failed: cats.reduce((n, c) => n + c.failed, 0),
    notAvailable: cats.filter((c) => c.status === 'NOT_AVAILABLE').length,
  };
}

export const publicAccount = (a) => ({ irepsAccountId: a.irepsAccountId, companyName: a.companyName, operatingUnit: a.operatingUnit, verified: !!a.verified });

/**
 * Run the given category steps at the same time: whatever IREPS has ready (NIT, attachments, LOA, counter offer...)
 * downloads straight away, and a slow or empty list (e.g. Negotiation) never holds the others back.
 * The run stops (and says why) if the account changes or the session ends.
 */
export async function runSteps(run, keys, onProgress = () => {}) {
  const categories = {};
  let aborted = null;
  if (run.ecm === undefined) run.ecm = await tenderEcmSink(run.account); // Save to: ECM / S3, or null
  const steps = STEPS.filter(([k]) => keys.includes(k));
  let started = 0;
  await Promise.all(steps.map(async ([key, msg, fn]) => {
    if (aborted) {
      categories[key] = failedCategory(TYPE[key], `Skipped: ${aborted.message}`);
      return;
    }
    onProgress(started++ === 0 ? msg : `${msg} (in parallel)`);
    run.onProgress = onProgress;
    try {
      await assertSameAccount(run.account, { base: run.base });
      categories[key] = await fn(run);
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'ACCOUNT_CHANGED') aborted = aborted || { code: e.code, message: e.message };
      else log(TYPE[key], `failed: ${e.message}`);
      categories[key] = failedCategory(TYPE[key], e.message);
    }
  }));
  return { categories, aborted };
}

export function startTenderRun(base, account, found, folderLabel) {
  const tenderContext = {
    tenderNo: found.tenderNo, tenderTitle: found.tenderTitle, railwayUnit: found.railwayUnit, department: found.department, tenderStatus: found.tenderStatus,
    closingDate: found.closingDate || '',
    nitId: null, nitOid: null, tenderOID: null,
    irepsAccountId: account.irepsAccountId, companyName: account.companyName, operatingUnit: account.operatingUnit,
    tenderPdfUrl: null, nitPageUrl: null, attachments: [], corrigenda: [], discoveredActions: {},
    searchUrl: found.searchUrl, row: found.row,
  };
  const saver = createSaver({ accountLabel: folderLabel, tenderNo: found.tenderNo });
  const run = { base, account, ctx: tenderContext, saver, ids: {}, idSource: {}, inboxCache: new Map(), nit: null, ledger: null, ledgerMode: 'record', onlyDate: '', dateRange: null };
  // identifiers present on the exact tender row itself
  for (const a of found.row.actions) for (const u of a.urls) noteIds(run, u, 'row_action');
  return { run, tenderContext, saver };
}

/** `only` limits the run to some categories (default: all), so each document type can be downloaded separately. */
export async function downloadTenderDocuments(rawTenderNo, { onProgress = () => {}, onAccount = () => {}, only = CATEGORY_KEYS } = {}) {
  const tenderNo = norm(rawTenderNo);
  if (!tenderNo) throw new TenderError('INPUT', 'Enter a Tender Number.');
  await ensureDownloadSignIn();

  const base = await getBaseUrl();
  onProgress('Verifying IREPS account...');
  const account = await getActiveIrepsAccountContext({ base });
  onAccount(account);
  if (!account.authenticated) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
  if (!account.verified) throw new TenderError('ACCOUNT', ACCOUNT_UNVERIFIED_MSG);
  const folderLabel = accountFolderLabel(account);

  onProgress('Finding Tender...');
  const found = await searchTender(base, tenderNo, { onProgress });

  const { run, tenderContext, saver } = startTenderRun(base, account, found, folderLabel);

  const { categories, aborted } = await runSteps(run, only, onProgress);

  tenderContext.nitId = run.ids.nitId || null;
  tenderContext.nitOid = run.ids.nitOid || null;
  tenderContext.tenderOID = run.ids.tenderOID || null;
  const { searchUrl, row, ...ctxPublic } = tenderContext;

  const result = {
    account: publicAccount(account),
    tender: { tenderNo: found.tenderNo, tenderTitle: found.tenderTitle, nitId: tenderContext.nitId, nitOid: tenderContext.nitOid },
    categories,
    exclusions: [...EXCLUSIONS],
    summary: summarize(categories),
    folder: `Downloads/${saver.root}/`,
    aborted,
    context: ctxPublic,
  };

  onProgress('Tender documents download complete.');
  return result;
}

export { SESSION_MSG };
