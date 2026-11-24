// Shared plumbing for the "Download Tender Documents" feature:
// authenticated requests, session detection, PDF validation, HTML -> PDF, saving, logging.
// Runs in the side-panel page (has DOMParser; host_permissions + credentials:'include'
// reuse the user's existing IREPS browser session - no credentials are read or stored).

import { IREPS_CONFIG, loadIrepsConfig } from '../services/ireps-api.js';
import { logger } from '../utils/logger.js';
import { describeError } from '../utils/messages.js';
import { sourceFileName } from '../utils/filename.js';
import { isIrepsLoginHtml } from '../utils/ireps-account.js';
import { sharedRun, LOCAL_SAVE_REFUSED } from './tender-shared-run.js';

/** The panel-wide session-expired text (utils/messages.js), so every view says the same. */
export const SESSION_MSG = describeError('IREPS_SESSION_EXPIRED').message;

/** Error codes meaning "IREPS itself did not answer" (as opposed to a rejected or invalid document). */
export const IREPS_DOWN_CODES = new Set(['TIMEOUT', 'UNREACHABLE']);

export class TenderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Strip anything that looks like a token / session id before it can reach the console. */
export function redact(msg) {
  return String(msg)
    .replace(/(JSESSIONID|TOKEN|password|passwd|otp|signature|cookie)(["'\s:=]+)[^\s&;,"']+/gi, '$1$2[redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');
}

const LOG_TAIL = [];
/**
 * Log a tender / correspondence line: through utils/logger.js (console + DocLink's stored
 * log, doclinkLog.dump()) and into the panel's own tail for "Copy diagnostics".
 * `level` is "info" (default), "warn" or "error".
 */
export function log(tag, msg, level = 'info') {
  const text = `[${tag}] ${redact(msg)}`;
  (logger[level] || logger.info)(text);
  LOG_TAIL.push(`${new Date().toISOString().slice(11, 19)} [DocLink]${text}`);
  if (LOG_TAIL.length > 400) LOG_TAIL.shift();
}

/** Recent (already redacted) log lines, for the "Copy diagnostics" button. */
export const getLogTail = () => LOG_TAIL.join('\n');

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** IREPS pages the tender and correspondence flows read (read-only). */
export const INBOX_PATH = '/epsn/vendorInboxLink.do';
export const CORRES_LIST_PATH = '/epsn/corres/vendorRelatedCorrespondence.do';
export const CORRES_REPLY_PATH = '/epsn/corres/vendorCorrespondencePendingReply.do';
/** A published correspondence letter, when the page names no route of its own. */
export const CORRES_VIEW_FALLBACK_PATH = '/epsn/corres/rly/viewpubIndltr.do';

/** A Date as IREPS writes it: dd/mm/yyyy (local time). */
export const dmyOf = (d = new Date()) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

/** The text of a page's inline <script> blocks (where IREPS keeps its routes). */
export const inlineScripts = (doc) => [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join('\n');

export const fileSafe = (s) => String(s ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_') || 'NA';

/** The IREPS origin, from the same loader the service worker uses (config.json + config.local.json). */
export async function getBaseUrl() {
  await loadIrepsConfig();
  return String(IREPS_CONFIG.baseUrl).replace(/\/+$/, '');
}

/** Resolve a (possibly relative) reference; refuses anything off the IREPS origin. */
export function absUrl(base, ref, relativeTo) {
  const u = new URL(ref, relativeTo || `${base}/epsn/`);
  if (u.origin !== new URL(base).origin) {
    throw new TenderError('BAD_URL', 'Refusing to request a URL outside the IREPS origin.');
  }
  return u.toString();
}

export function isPdfBytes(bytes) {
  // JSP output can lead the PDF with whitespace / stray markup, so look a little further in than the header
  const n = Math.min(bytes.length - 3, 8192);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

/**
 * commTboPdfAction.do serves "My Offer" and the tender's tabulations (pdfType=...). DocLink fetches My Offer
 * and the Financial and Commercial Tabulations ("ECM - Download speci-v1" types vft / vct); any other pdfType
 * (e.g. a Techno-Commercial Tabulation) stays OUT OF SCOPE. IREPS names the two files FIN-TAB-<no>-<oid>.pdf and
 * TECH-TAB-<no>-<oid>.pdf: TECH-TAB is the Commercial Tabulation, not a Techno-Commercial one (03 Nov 2026
 * capture), and passes only inside a commercialTabulation response (isExcludedTrustedLink). The guard sits at
 * the lowest request layer: nothing in this module can reach those endpoints, even by mistake.
 */
export const ALLOWED_PDF_TYPES = Object.freeze(['offer', 'financialtabulation', 'commercialtabulation']);

/** `url` may carry a request's body fields too (requestRefusal): every pdfType it names must be an allowed one. */
export function isExcludedUrl(url) {
  let u;
  try {
    u = new URL(url, 'https://x.invalid/');
  } catch {
    return false;
  }
  if (/commTboPdfAction\.do/i.test(u.pathname)) {
    const types = [...u.searchParams].filter(([k]) => k.toLowerCase() === 'pdftype').map(([, v]) => v.toLowerCase());
    return !types.length || types.some((t) => !ALLOWED_PDF_TYPES.includes(t));
  }
  // a tabulation file the page itself links to: Financial / Commercial pass, "techno" and unknown ones do not;
  // a TECH-TAB file (the Commercial Tabulation) only passes isExcludedTrustedLink, inside its own response
  const s = u.pathname + u.search;
  if (/techno|tech-?tab/i.test(s)) return true;
  return /tabulation/i.test(s) && !/financial|commercial/i.test(s);
}

// ---------------------------------------------------------------- the request guard
//
// Every request of tender/ (tender documents, correspondence, My Messages, the tender search, the account check)
// is sent by irepsFetchOnce, and irepsFetchOnce first passes exactly what it sends - the final URL and, for a POST,
// the form body - through requestRefusal():
//   1. Tabulations: of commTboPdfAction.do only My Offer and the Financial / Commercial Tabulation, and no
//      "techno" tabulation file (isExcludedUrl; TECH-TAB-<no>-<oid>.pdf only inside a commercialTabulation response).
//   2. Read-only: GET and POST only, and nothing that names a write action: a page whose name holds a write verb
//      (saveReply.do, vendorCorresSubmitReply.do, submitbid.do, finalSubmission.do, withdrawalOfBid.do,
//      logout.do ...), an IREPS page where a vendor submits something (negoBid.do, coResponse.do, bidProcess.do,
//      paymentProcess.do), or an action parameter (activity, Action, opValue, ajaxMode ...) that names one.
//      Files IREPS serves (.pdf, .docx, Submission_List.pdf ...) are not actions; a view such as
//      viewUploadedDoc.do is not one either (only whole words count, or a verb the name starts with).
// The ONE write that passes is LOA_VIEWED_UPDATE (below).

/** Write verbs, as a whole word of a page name or an action value ("vendorCorres|Submit|Reply", "final|Submission"). */
const WRITE_WORDS = new Set(['submit', 'submission', 'save', 'upload', 'delete', 'remove', 'approve', 'archive', 'withdraw', 'withdrawal',
  'update', 'insert', 'sign', 'cancel', 'reject', 'accept', 'confirm', 'logout', 'logoff', 'signout', 'signoff']);
/** Verbs that also count when the name starts with them run together with what follows ("submitbid", "logoutuser"). */
const WRITE_PREFIXES = ['submit', 'save', 'upload', 'delete', 'remove', 'approve', 'archive', 'withdraw', 'update', 'insert', 'logout', 'logoff', 'signout'];
/** IREPS pages where the vendor submits a bid, a response or a payment: DocLink never opens them. */
const VENDOR_ACTION_PAGES = /^(?:negoBid|coResponse|bidProcess|paymentProcess)\.do$/i;
/** Parameters that carry the action an IREPS page is asked to do (activity=viewNIT, opValue=ViewPublishedLetter, ajaxMode=...). */
const ACTION_PARAMS = /^(?:activity|action|actiontype|opvalue|op|operation|ajaxmode|reqmod|mode|method|dispatch|cmd|command|event|task|submittype)$/i;
/** Files IREPS serves: a name such as Submission_List.pdf is a document, not an action. */
const SERVED_FILE = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpe?g|png|gif|bmp|tiff?|rtf|txt|csv|dwg|dxf|xml|html?)$/i;

/** "vendorCorresSubmitReply" -> vendor, corres, submit, reply; "publishLOALetter" -> publish, loa, letter. */
const nameWords = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** True when a page name or an action value names a write action (see the rules above). */
export function namesWriteAction(name) {
  const words = nameWords(name);
  return words.some((w) => WRITE_WORDS.has(w)) || WRITE_PREFIXES.some((v) => (words[0] || '').startsWith(v));
}

/**
 * The ONE write request DocLink sends to IREPS, a documented exception to the read-only rule (H6; accepted by
 * the tech lead on 15 Nov 2026 as what IREPS's own button does). IREPS's own "View LOA Letter" link (loaLetterViewActivity)
 * POSTs this "LOA viewed" update first and opens the letter only when IREPS answers "OK"; DocLink does the
 * same, with the values read from that live script (tender-workflows.js readLoaViewScript). Only exactly this
 * request passes: POST, this path, no query, and these three fields (docId and docType digits) - anything else
 * that names a write, including another ajaxMode on the same path, is refused.
 */
export const LOA_VIEWED_UPDATE = Object.freeze({ method: 'POST', path: '/epsn/supply/tds/ajxdata.do', ajaxMode: 'updateLoaViewedDataByBidder', fields: Object.freeze(['ajaxMode', 'docId', 'docType']) });

function isLoaViewedUpdate(method, u, body) {
  if (method !== LOA_VIEWED_UPDATE.method || u.search || u.pathname !== LOA_VIEWED_UPDATE.path || !body) return false;
  const keys = [...body.keys()];
  return keys.length === LOA_VIEWED_UPDATE.fields.length && LOA_VIEWED_UPDATE.fields.every((k) => body.getAll(k).length === 1)
    && body.get('ajaxMode') === LOA_VIEWED_UPDATE.ajaxMode && /^\d+$/.test(body.get('docId')) && /^\d+$/.test(body.get('docType'));
}

const blockedMsg = (detail) => describeError('TENDER_REQUEST_BLOCKED', { detail }).message;
const EXCLUDED_MSG = 'This download is excluded from DocLink tender downloads (of the tabulations, only the Financial and Commercial Tabulation are allowed).';

/** Why the page `pathname` names may not be requested, or ''. */
function pageRefusal(pathname) {
  let last = pathname.split('/').pop() || '';
  try { last = decodeURIComponent(last); } catch { /* keep it encoded */ }
  if (!last || SERVED_FILE.test(last)) return '';
  const name = last.replace(/\.[A-Za-z0-9]+$/, '');
  if (/SubmitReply/i.test(name)) return 'Submitting a correspondence reply is never done by DocLink.';
  if (VENDOR_ACTION_PAGES.test(last)) return blockedMsg(`${last} is where a vendor submits in IREPS`);
  if (namesWriteAction(name)) return blockedMsg(last);
  return '';
}

/**
 * Why DocLink refuses to send this request, or null when it may: { code: 'EXCLUDED' (a tabulation out of scope)
 * | 'BLOCKED' (a write action), message }. `url` is the URL as sent and `body` the POST form (string or
 * URLSearchParams); `trusted` = inside an allowed tabulation response (isExcludedTrustedLink).
 */
export function requestRefusal({ method = 'GET', url, body = null, trusted = false } = {}) {
  let u;
  try {
    u = new URL(url, 'https://x.invalid/');
  } catch {
    return { code: 'BLOCKED', message: 'Malformed request refused.' };
  }
  const form = body ? (body instanceof URLSearchParams ? body : new URLSearchParams(String(body))) : null;
  // the request as the server sees it: every query AND body field (a POST's form counts, and a form field never
  // hides behind a query field of the same name - the tabulation rule runs on what is really sent)
  const seen = new URL(u.toString());
  for (const [k, v] of form || []) seen.searchParams.append(k, v);
  if (trusted ? isExcludedTrustedLink(seen.toString(), trusted) : isExcludedUrl(seen.toString())) return { code: 'EXCLUDED', message: EXCLUDED_MSG };
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET' && verb !== 'POST') return { code: 'BLOCKED', message: blockedMsg(`a ${verb} request`) };
  if (isLoaViewedUpdate(verb, u, form)) return null;
  const page = pageRefusal(u.pathname);
  if (page) return { code: 'BLOCKED', message: page };
  const action = [...u.searchParams, ...(form || [])].find(([k, v]) => ACTION_PARAMS.test(k) && namesWriteAction(v));
  return action ? { code: 'BLOCKED', message: blockedMsg(`${action[0]}=${action[1]}`) } : null;
}

/** Throws EXCLUDED / BLOCKED (TenderError) for a request DocLink must not send (requestRefusal). */
export function assertAllowedRequest(request) {
  const r = requestRefusal(request);
  if (r) throw new TenderError(r.code, r.message);
}

/** Authenticated request. `form` is an object / URLSearchParams (body for POST, query for GET). */
export const fetchSettings = { timeoutMs: 45000, waitMs: 180000, waitRetryMs: 5000, waitRetryMaxMs: 60000, netRetryMs: [1000, 3000] };

/** IREPS answers these while a page is still coming up (gateway / overloaded); worth waiting out. */
export const STILL_OPENING = new Set([502, 503, 504]);

/**
 * `wait` (Negotiation / Counter Offer): DocLink waits up to fetchSettings.waitMs (3 minutes) for IREPS to open
 * the page. Within that time a slow answer is waited for, and while IREPS cannot be reached or answers
 * 502/503/504 the request is retried with backoff (5s, 10s ... 60s); after it, the page fails as not responding.
 * `wait = { what, onWait(msg) }` names the page for the progress line.
 * Without `wait`, a GET that could not reach IREPS at all (a network failure, not a slow or refused answer) is
 * tried again after fetchSettings.netRetryMs (1s, then 3s); a POST never is: only a GET is safe to repeat.
 */
export async function irepsFetch(base, ref, opts = {}) {
  const { wait = null } = opts;
  if (!wait) return fetchRetryingNetwork(base, ref, opts);
  const what = wait.what || 'page';
  const minutes = `${+(fetchSettings.waitMs / 60000).toFixed(1)} minute${fetchSettings.waitMs === 60000 ? '' : 's'}`;
  const deadline = Date.now() + fetchSettings.waitMs;
  const giveUp = (why) => new TenderError('TIMEOUT', `Failed because IREPS is not responding (the ${what} did not open within ${minutes}; ${why}).`);
  for (let attempt = 1; ; attempt++) {
    let why;
    try {
      const res = await irepsFetchOnce(base, ref, { ...opts, timeoutMs: Math.max(deadline - Date.now(), 1) });
      if (!STILL_OPENING.has(res.status)) return res;
      why = `IREPS answered HTTP ${res.status}`;
    } catch (e) {
      if (e.code === 'TIMEOUT') throw giveUp('no answer');
      if (e.code !== 'UNREACHABLE') throw e;
      why = 'IREPS could not be reached';
    }
    const left = deadline - Date.now();
    if (left <= 0) throw giveUp(why);
    const delay = Math.min(fetchSettings.waitRetryMs * 2 ** Math.min(attempt - 1, 10), fetchSettings.waitRetryMaxMs, left);
    const msg = `Waiting for IREPS to open the ${what} (${why}; trying again in ${Math.round(delay / 1000)}s, attempt ${attempt}, up to ${minutes} in all)...`;
    log('Wait', msg);
    wait.onWait?.(msg);
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function fetchRetryingNetwork(base, ref, opts) {
  const isGet = String(opts.method || 'GET').toUpperCase() === 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      return await irepsFetchOnce(base, ref, opts);
    } catch (e) {
      const delay = fetchSettings.netRetryMs[attempt];
      if (!isGet || e.code !== 'UNREACHABLE' || delay === undefined) throw e;
      log('Fetch', `${e.message} Trying the GET again in ${delay / 1000}s (network failure ${attempt + 1}).`, 'warn');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function irepsFetchOnce(base, ref, { method = 'GET', form = null, relativeTo, timeoutMs = fetchSettings.timeoutMs, trusted = false } = {}) {
  let url = absUrl(base, ref, relativeTo);
  const params = form ? (form instanceof URLSearchParams ? form : new URLSearchParams(form)) : null;
  const init = { method, credentials: 'include', redirect: 'follow', headers: {} };
  if (params) {
    if (method === 'GET') {
      const u = new URL(url);
      for (const [k, v] of params) u.searchParams.set(k, v);
      url = u.toString();
    } else {
      init.body = params.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  // the one guard for every tender / correspondence request, run on exactly what is sent: the final URL and the
  // body (trusted: a file linked from inside an allowed Financial / Commercial Tabulation response)
  assertAllowedRequest({ method, url, body: init.body ?? null, trusted });
  // A portal page that never answers must not stall the whole run: give up after timeoutMs (0 = wait as long as it takes).
  const ctl = new AbortController();
  init.signal = ctl.signal;
  const timer = timeoutMs > 0 ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let res;
  let bytes;
  try {
    res = await fetch(url, init);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (ctl.signal.aborted) throw new TenderError('TIMEOUT', `Failed because IREPS is not responding (no answer within ${timeoutMs / 1000} seconds for ${new URL(url).pathname}).`);
    if (e instanceof TypeError) throw new TenderError('UNREACHABLE', `Failed because IREPS is not responding (could not reach ${new URL(url).pathname}).`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const contentType = res.headers.get('content-type') || '';
  let cached = null;
  return {
    status: res.status,
    ok: res.ok,
    url: res.url || url,
    contentType,
    headers: Object.fromEntries(res.headers.entries()),
    bytes,
    text() {
      if (cached === null) {
        const cs = (/charset=([\w-]+)/i.exec(contentType) || [])[1] || 'utf-8';
        try {
          cached = new TextDecoder(cs).decode(bytes);
        } catch {
          cached = new TextDecoder('windows-1252').decode(bytes);
        }
      }
      return cached;
    },
  };
}

export function isLoginResponse(res) {
  if (/userLogin\.do/i.test(res.url)) return true;
  if (isPdfBytes(res.bytes)) return false;
  if (res.contentType && !/html|text|xml/i.test(res.contentType)) return false;
  // the text rules are shared with the service worker's account check (utils/ireps-account.js)
  return isIrepsLoginHtml(res.url, res.text());
}

export function assertSession(res) {
  if (isLoginResponse(res)) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
}

export const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

// ---------------------------------------------------------------- is this the page DocLink asked for? (H4)
// "Nothing found" is only ever IREPS's own answer on the page DocLink asked for. A page these do not
// recognise (an error page served with HTTP 200, a changed layout) is never taken as an empty list: it is
// an error, or - after pages that were read - the list is reported as not read to its end (what was read
// is still downloaded, exactly as before).

/** True for the Tender Related Correspondence pages (list and details). */
export function isCorrespondencePage(doc) {
  return /Tender\s+Related\s+Correspondence/i.test(norm(doc.body?.textContent || ''));
}

/**
 * True for a page of the vendor inbox (vendorInboxLink.do: My Messages, the Post Tenders letter lists, Closed
 * Tenders). IREPS draws every one of them with its search form (buyerInboxLinkForm, id schForm), which holds the
 * Tender No and listType fields - also when the list itself is empty (captures of 22 Oct and 29 Oct 2026).
 */
export function isVendorInboxPage(doc) {
  return !!findForm(doc, (f) => f.querySelector('[name=tenderNo]') && f.querySelector('[name=listType]'));
}

/** The page's title (or its first words) for an error message: never its markup. */
export function pageLabel(doc) {
  const title = norm(doc.querySelector('title')?.textContent);
  return title ? `"${title}"` : `"${norm(doc.body?.textContent).slice(0, 60) || 'an empty page'}"`;
}

/** TenderError PAGE: IREPS answered `what` with a page DocLink does not recognise (`doc`: that page, for its title). */
export const pageNotRecognised = (what, doc = null) =>
  new TenderError('PAGE', describeError('TENDER_PAGE_NOT_RECOGNISED', { detail: doc ? `${what}: ${pageLabel(doc)}` : what }).message);

/** TenderError HTTP: IREPS answered `what` with an HTTP error, so the list may be missing documents. */
export const listFailed = (what, status) => {
  const e = new TenderError('HTTP', describeError('TENDER_LIST_FAILED', { detail: `${what}: IREPS returned HTTP ${status}` }).message);
  e.status = status;
  return e;
};

// ---------------------------------------------------------------- what DocLink itself opened (M23)
// The print tabs DocLink creates, the blob: URLs it downloads from and the files it saved: during a run only
// a tab one of these explains is closed (view-common.js guardTabs), never a tab or file of the user's own.
// files: the full paths Chrome reported; requested: "DocLink/<unit>/.../<name>" as asked for, noted before the
// download starts, so a tab Chrome opens for the file the moment it is saved is recognised too
const OWN = { tabs: new Set(), blobs: new Set(), files: new Set(), requested: new Set() };
const pathKey = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:\/)/, '').toLowerCase();

/** A file path (pathKey form) that is one DocLink saved: as reported by Chrome, or as requested (also "name (1).ext"). */
function isOwnFile(p) {
  if (OWN.files.has(p)) return true;
  const plain = p.replace(/ \(\d+\)(?=\.[^./]*$|$)/, ''); // Chrome's uniquified "name (1).pdf"
  for (const r of OWN.requested) if (p.endsWith(`/${r}`) || plain.endsWith(`/${r}`)) return true;
  return false;
}

/** Note a tab DocLink created (tender-print.js), so the popups its page opens can be told apart. */
export const noteOwnTab = (tabId) => { if (tabId !== undefined && tabId !== null) OWN.tabs.add(tabId); };

/**
 * True when `tab` (a chrome.tabs.Tab) was opened by DocLink's own work: a popup of one of its print tabs, or
 * Chrome showing a blob: URL DocLink downloaded from or a file DocLink saved (the "open when done" PDF viewer).
 */
export function isDocLinkStrayTab(tab) {
  if (!tab) return false;
  if (tab.openerTabId !== undefined && tab.openerTabId !== null && OWN.tabs.has(tab.openerTabId)) return true;
  for (const url of [tab.pendingUrl, tab.url]) {
    if (!url) continue;
    if (/^blob:/i.test(url) && OWN.blobs.has(url.split('#')[0])) return true;
    if (/^file:/i.test(url)) {
      let path = '';
      try { path = decodeURIComponent(new URL(url).pathname); } catch { /* not a file URL */ }
      if (path && isOwnFile(pathKey(path))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- forms

/** Serialise a parsed <form> the way a browser would on submit (minus buttons/files). */
export function formParams(form) {
  const p = new URLSearchParams();
  if (!form) return p;
  for (const el of form.elements) {
    const name = el.getAttribute('name');
    if (!name || el.disabled) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      if (el.multiple) for (const o of el.selectedOptions) p.append(name, o.value);
      else if (el.options.length) p.append(name, el.value);
    } else if (tag === 'textarea') {
      p.append(name, el.value);
    } else if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      p.append(name, el.value);
    }
  }
  return p;
}

export function findForm(doc, pred) {
  return [...doc.querySelectorAll('form')].find(pred) || null;
}

// ---------------------------------------------------------------- link / action extraction

/** Parse `fn('a','b',c)` invocations out of an inline handler. -> [{ fn, args: string[] }] */
export function parseCalls(src) {
  src = String(src).replace(/(['"])\s*\+\s*(['"])/g, ''); // 'a' + 'b' -> 'ab' (IREPS builds some letter URLs by concatenation)
  const calls = [];
  const re = /([A-Za-z_$][\w$.]*)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex;
    const args = [];
    let cur = '';
    let quote = '';
    let depth = 1;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = '';
        else cur += ch;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') {
        depth++;
        cur += ch;
      } else if (ch === ')') {
        depth--;
        if (depth > 0) cur += ch;
      } else if (ch === ',' && depth === 1) {
        args.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    args.push(cur.trim());
    calls.push({ fn: m[1], args: args.filter((a, k) => a !== '' || k === 0) });
    re.lastIndex = Math.max(re.lastIndex, m.index + m[0].length);
  }
  return calls;
}

const URLISH = /^(?:https?:)?\/[^\s'"]*$|^[^\s'"]*?\.(?:do|pdf|jsp|html?|docx?|xlsx?|zip|rar|jpe?g|png|tiff?)(?:[?#][^\s'"]*)?$/i;

function flattenStringConcat(value) {
  const text = String(value ?? '');
  if (!text.includes('+')) return text;
  const parts = [];
  let part = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      part += ch;
      if (ch === '\\' && i + 1 < text.length) {
        part += text[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      part += ch;
      continue;
    }
    if (ch === '+') {
      parts.push(part);
      part = '';
      continue;
    }
    part += ch;
  }
  parts.push(part);
  return parts.map((p) => {
    const s = p.trim();
    if (!s) return '';
    if ((/^['"]/).test(s) && /['"]$/.test(s) && s.length >= 2) return s.slice(1, -1);
    if (/^(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/.test(s)) return '';
    return s;
  }).join('');
}

/**
 * Every clickable thing under `root` with the requests it can trigger.
 * `reqs` mirrors how IREPS's own page script would issue each URL:
 *   postRequest* / class="postRequest" url=...  -> POST (query string becomes the form body)
 *   window.open / href / anything else          -> GET
 */
export function elementActions(root) {
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll('a,area,[onclick],button,input[type=button]')) {
    const href = el.getAttribute('href') || '';
    const onclick = el.getAttribute('onclick') || '';
    const urlAttr = el.getAttribute('url') || '';
    const img = el.querySelector?.('img');
    const title = norm(el.getAttribute('title') || img?.getAttribute('title') || el.getAttribute('alt') || img?.getAttribute('alt'));
    const text = norm(el.textContent);
    const reqs = [];
    const addReq = (url, method, extra = {}) => {
      if (url && !reqs.some((r) => r.url === url && r.method === method)) reqs.push({ url, method, ...extra });
    };
    if (href && !/^(#|javascript:)/i.test(href)) addReq(href, 'GET', { fn: 'href' });
    if (urlAttr && /(^|\s)postRequest(\s|$)/i.test(el.getAttribute('class') || '')) addReq(urlAttr, 'POST', { fn: 'postRequest' });
    const calls = parseCalls(href.startsWith('javascript:') ? href : onclick);
    for (const c of calls) {
      const post = /^postRequest/i.test(c.fn) || /^loaLetterViewActivity$/i.test(c.fn);
      const first = c.args.find((a) => URLISH.test(flattenStringConcat(a)) || URLISH.test(a));
      if (first) addReq(flattenStringConcat(first), post ? 'POST' : 'GET', { fn: c.fn, args: c.args });
    }
    // anything URL-shaped that parseCalls did not classify (e.g. nested handlers)
    if (!reqs.length) {
      const flattened = flattenStringConcat(href + ' ' + onclick);
      for (const m of flattened.matchAll(/['"]([^'"\s]*?(?:\.do|\.pdf)[^'"\s]*)['"]/gi)) {
        if (!reqs.some((r) => r.url === m[1])) addReq(m[1], 'GET', { fn: 'other' });
      }
    }
    const urls = [...new Set(reqs.map((r) => r.url))];
    const key = `${urls.join('|')}#${onclick}#${href}#${title}#${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, text, label: norm(`${title} ${text}`), href, onclick, urls, reqs, calls });
  }
  return out;
}

export function qparam(url, name) {
  try {
    const u = new URL(url, 'https://x.invalid/');
    const want = name.toLowerCase();
    for (const [k, v] of u.searchParams) if (k.toLowerCase() === want) return v;
  } catch {
    /* ignore */
  }
  return '';
}

/** Split `url` into the request IREPS's page script would send: POST => query becomes form body. */
export function toRequest(url, method = 'GET', { prefix = '' } = {}) {
  const [path, ...rest] = String(url).split('?');
  const query = rest.join('?');
  const fixed = path.startsWith('/') && prefix && !path.startsWith(prefix) ? prefix + path : path;
  if (method === 'POST') {
    const form = new URLSearchParams();
    // postRequest.js splits on & and = without decoding; mirror that
    for (const part of query ? query.split('&') : []) {
      if (!part) continue;
      const k = part.indexOf('=');
      form.append(k < 0 ? part : part.slice(0, k), k < 0 ? '' : part.slice(k + 1));
    }
    return { method: 'POST', url: fixed, form };
  }
  return { method: 'GET', url: query ? `${fixed}?${query}` : fixed, form: null };
}

/** Stable identity of a request, used to avoid downloading the same document twice. */
export function requestKey(req) {
  const u = new URL(req.url, 'https://x.invalid/');
  const params = [...u.searchParams, ...(req.form || [])].map(([k, v]) => `${k}=${v}`).sort();
  return `${req.method} ${u.pathname} ${params.join('&')}`;
}

// ---------------------------------------------------------------- byte sniffing

/** -> 'pdf' | 'zip' | 'ole' | 'png' | 'jpg' | 'gif' | 'tiff' | 'rtf' | 'html' | 'text' | 'unknown' */
export function sniffKind(bytes) {
  if (!bytes || !bytes.length) return 'empty';
  if (isPdfBytes(bytes)) return 'pdf';
  const b = bytes;
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return 'tiff';
  const head = new TextDecoder('latin1').decode(b.subarray(0, 2048));
  if (/^\s*\{\\rtf/i.test(head)) return 'rtf';
  if (/<\s*(!doctype\s+html|html|head|body|table|form|script|meta|title)\b/i.test(head)) return 'html';
  // printable-only => text
  let printable = 0;
  const n = Math.min(b.length, 512);
  for (let i = 0; i < n; i++) if (b[i] === 9 || b[i] === 10 || b[i] === 13 || (b[i] >= 32 && b[i] < 127)) printable++;
  return printable / n > 0.95 ? 'text' : 'unknown';
}

const KIND_EXT = { pdf: '.pdf', zip: '.zip', ole: '.doc', png: '.png', jpg: '.jpg', gif: '.gif', tiff: '.tif', rtf: '.rtf', text: '.txt' };

/** Original extension from the URL / Content-Disposition when it is a sane document type. */
export function hintedExtension(res, nameHint = '') {
  const cd = res?.headers?.['content-disposition'] || '';
  const fromCd = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)?.[1] || '';
  for (const cand of [fromCd, nameHint, (() => { try { return new URL(res.url).pathname; } catch { return ''; } })()]) {
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(decodeURIComponent(String(cand).split('?')[0]));
    if (m && !/^(do|jsp|html?|php|aspx?)$/i.test(m[1])) return '.' + m[1].toLowerCase();
  }
  return '';
}

export function extensionFor(kind, res, nameHint) {
  if (kind === 'pdf') return '.pdf';
  return hintedExtension(res, nameHint) || KIND_EXT[kind] || '.bin';
}

// ---------------------------------------------------------------- generic document resolver

const BINARY_DOC_KINDS = new Set(['pdf', 'zip', 'ole', 'png', 'jpg', 'gif', 'tiff', 'rtf']);

/** The file IREPS opens for "View Commercial Tabulation" (pdfType=commercialTabulation), captured 03 Nov 2026. */
const COMMERCIAL_TAB_FILE = /^\/ireps\/supply\/pdfdocs\/+\d+\/\d+\/TECH-TAB-[^/]+\.pdf$/i;

/**
 * A link inside a response that is already an allowed Financial / Commercial Tabulation (`pdfType`, or true):
 * its file may be named "Tabulation_<oid>.pdf" without saying which one, so only the Techno-Commercial patterns
 * (and any other commTboPdfAction.do pdfType) are refused there. IREPS names the Commercial Tabulation's own
 * PDF "TECH-TAB-<no>-<oid>.pdf": that one file passes, and only inside a commercialTabulation response.
 */
function isExcludedTrustedLink(url, pdfType = true) {
  if (isExcludedUrl(url) === false) return false;
  let u;
  try {
    u = new URL(url, 'https://x.invalid/');
  } catch {
    return false;
  }
  if (/commTboPdfAction\.do/i.test(u.pathname)) return true;
  if (pdfType === 'commercialTabulation' && !u.search && COMMERCIAL_TAB_FILE.test(u.pathname) && !/techno/i.test(u.pathname)) return false;
  return /techno|tech-?tab/i.test(u.pathname + u.search);
}

/** window.open('...') / location = '...' targets in the page's handlers and scripts (any extension). */
const SCRIPT_TARGET_RE = /(?:window\.open|location\.(?:href|replace|assign))\s*(?:\(\s*|=\s*)['"]([^'"\s]+)['"]|(?:window\.|document\.)location\s*=\s*['"]([^'"\s]+)['"]/gi;

function docCandidates(doc, pageUrl, base, allowAnyFile, trusted = false) {
  const ext = allowAnyFile ? '(?:pdf|docx?|xlsx?|zip|rar|jpe?g|png|tiff?|rtf|txt)' : 'pdf';
  const isDoc = new RegExp(`\\.${ext}(\\?|#|$)`, 'i');
  const raw = [];
  for (const el of doc.querySelectorAll('a[href],iframe[src],embed[src],object[data]')) {
    const v = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data') || '';
    if (isDoc.test(v)) raw.push(v);
  }
  // viewers often embed the real file through a servlet URL with no extension; tried after the obvious ones,
  // and only accepted when the response is actually a document (see resolveIrepsDocument)
  for (const el of doc.querySelectorAll('iframe[src],frame[src],embed[src],object[data]')) {
    const v = el.getAttribute('src') || el.getAttribute('data') || '';
    if (v && !/^(about:|javascript:|#|data:)/i.test(v) && !raw.includes(v)) raw.push(v);
  }
  // onload too: the tabulation page opens its PDF from <body onload="openwindow('...FIN-TAB-<no>-<oid>.pdf')">
  const inline = [...doc.querySelectorAll('[onclick],[onload]')].map((e) => `${e.getAttribute('onclick') || ''} ${e.getAttribute('onload') || ''}`).join(' ') +
    ' ' + [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join(' ');
  for (const m of inline.matchAll(new RegExp(`['"]([^'"\\s]*\\.${ext}(?:\\?[^'"\\s]*)?)['"]`, 'gi'))) raw.push(m[1]);
  // a tabulation viewer may open its file through a servlet URL; only accepted when it answers with a document
  if (trusted) for (const m of inline.matchAll(SCRIPT_TARGET_RE)) raw.push(m[1] || m[2]);
  const out = [];
  for (const r of raw) {
    if (!r || /^(about:|javascript:|#|data:)/i.test(r)) continue;
    try {
      const u = absUrl(base, r, pageUrl);
      // the request guard decides here too: a link to a write action or an excluded tabulation is not a candidate
      if (!requestRefusal({ method: 'GET', url: u, trusted }) && !out.includes(u)) out.push(u);
    } catch {
      /* off-origin or malformed: skip */
    }
  }
  return out;
}

function metaRedirect(doc, html) {
  const m = doc.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content') || '';
  const u = /url\s*=\s*['"]?([^'";]+)/i.exec(m)?.[1] ||
    /(?:window\.|document\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i.exec(html)?.[1];
  return u || '';
}

/**
 * A viewer page that posts itself on to the file (<form> + .submit() on load), as postRequest.js does:
 * -> { url, method, form } or null. Only used inside a trusted tabulation response.
 */
function selfSubmittingForm(doc, html) {
  const forms = [...doc.querySelectorAll('form[action]')];
  if (forms.length !== 1) return null;
  const onload = doc.body?.getAttribute('onload') || '';
  if (!/\.submit\s*\(\s*\)/.test(`${onload} ${[...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join(' ')}`) && !/\.submit\s*\(\s*\)/.test(html)) return null;
  const f = forms[0];
  return { url: f.getAttribute('action'), method: /^get$/i.test(f.getAttribute('method') || '') ? 'GET' : 'POST', form: formParams(f) };
}

/**
 * The name IREPS gave a file it served (Content-Disposition, else the URL that answered, else the link
 * followed), or '' when none names a file of this type: the file is then saved under DocLink's name.
 */
function sourceNameOf(res, ext, linkUrl = '') {
  const name = sourceFileName({ contentDisposition: res.headers?.['content-disposition'], url: res.url }) || sourceFileName({ url: linkUrl });
  return name && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : '';
}

/** What a response was, for the log: never its body, cookies or tokens. */
export function describeResponse(res) {
  const cd = res.headers?.['content-disposition'] || '';
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd)?.[1] || '';
  let path = '';
  try { path = new URL(res.url).pathname; } catch { /* keep blank */ }
  return `${path} -> HTTP ${res.status}, ${res.contentType || 'no content-type'}${name ? `, file "${name}"` : ''}, ${res.bytes?.length ?? 0} bytes, ${sniffKind(res.bytes)}`;
}

/** "title: first words" of a web page, for a failure reason. */
function pageSummary(doc) {
  const title = norm(doc.querySelector('title')?.textContent);
  const text = norm(doc.body?.textContent).slice(0, 120);
  return [title, text].filter(Boolean).join(': ') || 'an empty page';
}

export function looksLikeErrorPage(doc) {
  const title = norm(doc.querySelector('title')?.textContent);
  const text = norm(doc.body?.textContent);
  if (text.length < 40) return 'The IREPS page was empty.';
  if (/\b(error|exception|access denied|forbidden|not authori[sz]ed)\b/i.test(title)) return `IREPS returned an error page (${title}).`;
  return '';
}

/**
 * Turn an IREPS response into a validated document.
 *   -> { kind:'file', bytes, ext, converted:false }                 real PDF / document bytes
 *   -> { kind:'html', html, bytes, ext:'.pdf', converted:true, page } print-ready HTML (+ locally rendered text PDF;
 *                                                                    page = the response as received, for tender-print.js)
 * A page that links a document file is normally a viewer of it, so the file is returned instead of the page.
 * keepPage: the page is the document itself (a corrigendum) and the files it links are its attachments:
 * the page is returned with links = their URLs (fetchLinkedDocument). Only a page with no readable
 * content of its own still gives way to the file it links.
 * pageOnly: the page IS the document (an LOA letter): nothing it links, embeds or redirects to is fetched,
 * so the result is that page alone (or the file IREPS answered with directly).
 * trusted: the response is an allowed Financial / Commercial Tabulation (its pdfType, or true); the file it
 * leads to is followed through isExcludedTrustedLink, including a self-submitting form and window.open /
 * location / onload targets.
 * logAs: a log tag; each response and candidate tried is logged (describeResponse).
 * Throws SESSION_EXPIRED for login pages; NO_DOCUMENT when nothing usable is found.
 * A login / error page is never returned as a document.
 */
export async function resolveIrepsDocument(base, res, { allowHtml = true, allowAnyFile = false, keepPage = false, pageOnly = false, trusted = false, logAs = '', nameHint = '', depth = 0, wait = null } = {}) {
  if (logAs) log(logAs, `Response ${describeResponse(res)}`);
  assertSession(res);
  if (res.status !== 200) throw new TenderError('HTTP', `IREPS returned HTTP ${res.status}.`);
  const kind = sniffKind(res.bytes);
  if (kind === 'empty') throw new TenderError('EMPTY', 'IREPS returned an empty response.');
  const meta = { httpStatus: res.status, contentType: res.contentType };
  if (kind === 'pdf') return { kind: 'file', bytes: res.bytes, ext: '.pdf', converted: false, sourceName: sourceNameOf(res, '.pdf'), ...meta };
  if (allowAnyFile && BINARY_DOC_KINDS.has(kind)) {
    const ext = extensionFor(kind, res, nameHint);
    return { kind: 'file', bytes: res.bytes, ext, converted: false, sourceName: sourceNameOf(res, ext), ...meta };
  }
  if (kind !== 'html' && kind !== 'text') {
    throw new TenderError('NOT_DOCUMENT', `IREPS returned an unrecognised file type (${res.contentType || 'unknown'}).`);
  }

  const html = res.text();
  const doc = parseHtml(html);
  if (pageOnly) {
    if (!allowHtml) throw new TenderError('NO_DOCUMENT', 'IREPS did not return a document file (only a web page).');
    const bad = looksLikeErrorPage(doc);
    if (bad) throw new TenderError('NO_DOCUMENT', bad);
    const lines = htmlToLines(doc);
    if (!lines.length) throw new TenderError('NO_DOCUMENT', 'The IREPS page had no readable content.');
    return { kind: 'html', html, bytes: buildPdf(wrapLines(lines)), ext: '.pdf', converted: true, page: { url: res.url, bytes: res.bytes, contentType: res.contentType }, ...meta };
  }
  const candidates = docCandidates(doc, res.url, base, allowAnyFile, trusted);
  if (logAs) log(logAs, candidates.length ? `The page links ${candidates.map((u) => { try { return new URL(u).pathname; } catch { return u; } }).join(', ')}` : 'The page links no document file');
  const linkedFile = async () => {
    for (const url of candidates) {
      const r = await irepsFetch(base, url, { wait, trusted });
      if (logAs) log(logAs, `Linked ${describeResponse(r)}`);
      assertSession(r);
      const k = sniffKind(r.bytes);
      if (r.status === 200 && (k === 'pdf' || (allowAnyFile && BINARY_DOC_KINDS.has(k)))) {
        const ext = extensionFor(k, r, url);
        return { kind: 'file', bytes: r.bytes, ext, converted: false, sourceName: sourceNameOf(r, ext, url), httpStatus: r.status, contentType: r.contentType };
      }
    }
    return null;
  };

  keepPage = keepPage && allowHtml;
  if (!keepPage) {
    const file = await linkedFile();
    if (file) return file;
  }

  const follow = { allowHtml, allowAnyFile, keepPage, trusted, logAs, nameHint, depth: depth + 1, wait };
  if (depth < 1 && trusted) {
    // a viewer that posts itself on to the file, as the IREPS popup would
    const sub = selfSubmittingForm(doc, html);
    if (sub) {
      if (logAs) log(logAs, `The page submits itself to ${sub.method} ${sub.url}`);
      const r = await irepsFetch(base, sub.url, { method: sub.method, form: sub.form, relativeTo: res.url, wait, trusted });
      return resolveIrepsDocument(base, r, follow);
    }
  }
  if (depth < 1 && !(keepPage && candidates.length)) {
    const next = metaRedirect(doc, html);
    if (next) {
      const r = await irepsFetch(base, next, { relativeTo: res.url, wait, trusted });
      return resolveIrepsDocument(base, r, follow);
    }
  }

  if (!allowHtml) throw new TenderError('NO_DOCUMENT', `IREPS did not return a document file (only a web page${logAs ? `: "${pageSummary(doc)}"` : ''}).`);
  const bad = looksLikeErrorPage(doc);
  const lines = bad ? [] : htmlToLines(doc);
  if (keepPage && !lines.length) {
    // nothing to read on the page itself: it was a viewer of the file after all
    const file = await linkedFile();
    if (file) return file;
  }
  if (bad) throw new TenderError('NO_DOCUMENT', bad);
  if (!lines.length) throw new TenderError('NO_DOCUMENT', 'The IREPS page had no readable content.');
  return { kind: 'html', html, bytes: buildPdf(wrapLines(lines)), ext: '.pdf', converted: true, page: { url: res.url, bytes: res.bytes, contentType: res.contentType },
    ...(keepPage ? { links: candidates } : {}), ...meta };
}

const DOC_FILE_URL = /\.(?:pdf|docx?|xlsx?|zip|rar|jpe?g|png|tiff?|rtf|txt)(?:[?#]|$)/i;

/**
 * A document file a page links to (a corrigendum's attachment, from resolveIrepsDocument links).
 *   -> { kind:'file', bytes, ext, ... }, or null when the link is not a document at all (an embedded
 *      viewer or servlet URL with no file extension that answers with a web page).
 * Throws when a link to a document file (.pdf, .docx, ...) does not give one.
 */
export async function fetchLinkedDocument(base, url, { allowAnyFile = false, wait = null } = {}) {
  const res = await irepsFetch(base, url, { wait });
  try {
    return await resolveIrepsDocument(base, res, { allowHtml: false, allowAnyFile, nameHint: url, wait });
  } catch (e) {
    if (['NO_DOCUMENT', 'NOT_DOCUMENT'].includes(e.code) && !DOC_FILE_URL.test(url)) return null;
    throw e;
  }
}

/**
 * Issue the request exactly as the IREPS page would (req = { method, url, form, relativeTo })
 * and resolve the response into a validated document.
 */
export async function fetchDocument(base, req, opts = {}) {
  const res = await irepsFetch(base, req.url, { method: req.method || 'GET', form: req.form || null, relativeTo: req.relativeTo, wait: req.wait || null });
  if (opts.logAs) log(opts.logAs, `Requested ${req.method || 'GET'} ${String(req.url).split('?')[0]}${req.form ? ` (fields ${[...new URLSearchParams(req.form).keys()].join(', ')})` : ''}`);
  return resolveIrepsDocument(base, res, { ...opts, wait: req.wait || null });
}

// ---------------------------------------------------------------- HTML -> text lines -> PDF

const DROP = 'script,style,noscript,iframe,nav,select,button,link,meta,input[type=button],input[type=submit],input[type=hidden],input[type=image]';
const CHROME_TOKENS = /^(menu|navbar|nav|sidebar|breadcrumb|toolbar|topmenu)$/i;
const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'table', 'section', 'pre', 'center', 'form', 'fieldset', 'blockquote', 'tbody', 'thead']);

export function htmlToLines(doc) {
  const body = doc.body ? doc.body.cloneNode(true) : doc.documentElement.cloneNode(true);
  body.querySelectorAll(DROP).forEach((n) => n.remove());
  body.querySelectorAll('[id],[class]').forEach((n) => {
    const toks = `${n.getAttribute('id') || ''} ${n.getAttribute('class') || ''}`.split(/\s+/);
    if (toks.some((t) => CHROME_TOKENS.test(t))) n.remove();
  });
  const lines = [];
  let cur = '';
  const flush = () => {
    const t = norm(cur);
    if (t) lines.push(t);
    cur = '';
  };
  const walk = (n) => {
    if (n.nodeType === 3) {
      cur += n.nodeValue.replace(/\s+/g, ' ');
      return;
    }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'br') return flush();
    if (tag === 'hr') {
      flush();
      lines.push('-'.repeat(60));
      return;
    }
    if (tag === 'tr') {
      flush();
      const cells = [...n.children].filter((c) => /^t[dh]$/i.test(c.tagName));
      if (cells.some((c) => c.querySelector('table'))) {
        cells.forEach(walk);
        flush();
      } else {
        const t = cells.map((c) => norm(c.textContent)).filter(Boolean).join(' | ');
        if (t) lines.push(t);
      }
      return;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    n.childNodes.forEach(walk);
    if (block) flush();
  };
  walk(body);
  flush();
  return lines;
}

const CHAR_MAP = { '\u2013': '-', '\u2014': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '*', '₹': 'Rs.', '…': '...' };
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const FONT_SIZE = 9;
const LEADING = 11;
export const CHARS_PER_LINE = Math.floor((PAGE_W - 2 * MARGIN) / (FONT_SIZE * 0.6)); // Courier = 0.6em
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

function sanitize(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (CHAR_MAP[ch]) out += CHAR_MAP[ch];
    else if (c < 32 || c === 127) out += ' ';
    else if (c <= 255) out += ch;
    else out += '?';
  }
  return out;
}

/** Word-wrap to the Courier grid and split into pages. -> string[][] */
export function wrapLines(lines) {
  const wrapped = [];
  for (const raw of lines) {
    let line = sanitize(raw);
    while (line.length > CHARS_PER_LINE) {
      let cut = line.lastIndexOf(' ', CHARS_PER_LINE);
      if (cut < CHARS_PER_LINE / 2) cut = CHARS_PER_LINE;
      wrapped.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    wrapped.push(line);
  }
  const pages = [];
  for (let i = 0; i < wrapped.length; i += LINES_PER_PAGE) pages.push(wrapped.slice(i, i + LINES_PER_PAGE));
  return pages;
}

function pdfEscape(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out;
}

/** Minimal valid PDF (Courier, A4). pages: string[][] */
export function buildPdf(pages) {
  if (!pages.length) throw new TenderError('NO_DOCUMENT', 'Nothing to write to PDF.');
  const objs = [];
  const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  pages.forEach((lines, i) => {
    const pObj = 4 + i * 2;
    const cObj = pObj + 1;
    kids.push(`${pObj} 0 R`);
    let s = `BT\n/F1 ${FONT_SIZE} Tf\n${LEADING} TL\n${MARGIN} ${PAGE_H - MARGIN} Td\n`;
    for (const l of lines) s += `(${pdfEscape(l)}) Tj T*\n`;
    s += 'ET\n';
    objs[pObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cObj} 0 R >>`;
    objs[cObj] = `<< /Length ${s.length} >>\nstream\n${s}endstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// ---------------------------------------------------------------- saving

export const DOWNLOAD_ROOT = 'DocLink';

/** One safe path segment: no separators, no "..", no leading/trailing dots or spaces, bounded length. */
export function safeSegment(s, max = 100) {
  let t = fileSafe(s).replace(/\.{2,}/g, '.').replace(/^[.\s]+|[.\s]+$/g, '');
  if (t.length > max) t = t.slice(0, max).replace(/[.\s]+$/g, '');
  return t || 'NA';
}

const MIME = { '.pdf': 'application/pdf', '.html': 'text/html', '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg' };

/**
 * Saves into Downloads/DocLink/<accountLabel>/Tender_<tenderNo>/<subdir>/<file>.
 * Names are unique within a run (no silent overwrite) and every path is sanitised. A file of an earlier run
 * with the same name is kept: Chrome saves the new one as "<name> (1).<ext>" (conflict 'uniquify'), and
 * save() returns that name, the one on disk (L11; requestedPath: the name DocLink asked for).
 */
export function createSaver({ accountLabel, tenderNo, subPath = null, conflict = 'uniquify' }) {
  // `subPath` (e.g. ['Correspondence','Pending',<tenderNo>]) replaces the default Tender_<no> folder.
  const root = subPath
    ? [DOWNLOAD_ROOT, safeSegment(accountLabel), ...subPath.map((p) => safeSegment(p))].join('/')
    : `${DOWNLOAD_ROOT}/${safeSegment(accountLabel)}/Tender_${safeSegment(tenderNo)}`;
  const used = new Set();

  // exact: the name was already made unique by the caller (reserveFileName), so it is not changed here
  function uniquePath(subdir, fileName, exact = false) {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    const dir = subdir ? `${safeSegment(subdir)}/` : '';
    let name = `${safeSegment(stem, 120)}${ext.replace(/[^.\w]/g, '')}`;
    if (!exact) for (let n = 2; used.has(`${dir}${name}`.toLowerCase()); n++) name = `${safeSegment(stem, 120)}_${n}${ext.replace(/[^.\w]/g, '')}`;
    used.add(`${dir}${name}`.toLowerCase());
    return `${dir}${name}`;
  }

  async function save(subdir, fileName, bytes, mime, { exact = false } = {}) {
    // a scheduled run (tender-shared-run.js) saves to the ECM only: a local save is a failed document
    if (sharedRun()) throw new TenderError(LOCAL_SAVE_REFUSED, `A scheduled download saves to the ECM only, never to Downloads (${fileName}).`);
    if (!bytes || !bytes.length) throw new TenderError('EMPTY', 'Refusing to save an empty file.');
    const ext = (/\.[A-Za-z0-9]+$/.exec(fileName) || [''])[0].toLowerCase();
    if (ext === '.pdf' && !isPdfBytes(bytes)) throw new TenderError('NOT_PDF', 'Refusing to save a non-PDF payload as .pdf.');
    if (ext !== '.html' && ext !== '.txt' && ext !== '.json' && sniffKind(bytes) === 'html') {
      throw new TenderError('NOT_DOCUMENT', 'Refusing to save a web page as a document file.');
    }
    const rel = uniquePath(subdir, fileName, exact);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || MIME[ext] || 'application/octet-stream' }));
    OWN.blobs.add(url);
    OWN.requested.add(pathKey(`${root}/${rel}`));
    try {
      const id = await chrome.downloads.download({ url, filename: `${root}/${rel}`, conflictAction: conflict, saveAs: false });
      await waitForDownload(id);
      const relPath = await savedRelPath(id, rel);
      log('Download', relPath === rel ? `File saved ${rel}` : `File saved ${relPath} (a file ${rel.split('/').pop()} was there already)`);
      return { relPath, downloadId: id, size: bytes.length, ...(relPath !== rel ? { requestedPath: rel } : {}) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { root, save };
}

/**
 * The path, relative to the saver's root, of the file Chrome really wrote for download `id` (its
 * DownloadItem.filename, which differs from `rel` when Chrome had to uniquify the name), or `rel` when Chrome
 * does not say. The file is noted as DocLink's own (isDocLinkStrayTab); its full path is never stored.
 */
async function savedRelPath(id, rel) {
  try {
    const [item] = await chrome.downloads.search({ id });
    const full = String(item?.filename || '');
    if (!full) return rel;
    OWN.files.add(pathKey(full));
    const parts = full.replace(/\\/g, '/').split('/').filter(Boolean);
    const depth = rel.split('/').length;
    return parts.length >= depth ? parts.slice(-depth).join('/') : rel;
  } catch {
    return rel;
  }
}

function waitForDownload(id, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      fn(v);
    };
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') done(resolve);
      else if (d.state.current === 'interrupted') done(reject, new TenderError('SAVE', 'Chrome interrupted the download.'));
    };
    const timer = setTimeout(() => done(reject, new TenderError('SAVE', 'Timed out saving the file.')), timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') done(resolve);
      else if (item?.state === 'interrupted') done(reject, new TenderError('SAVE', 'Chrome interrupted the download.'));
    });
  });
}

