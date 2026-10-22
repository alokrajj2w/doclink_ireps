// Shared plumbing for the "Download Tender Documents" feature:
// authenticated requests, session detection, PDF validation, HTML -> PDF, saving, logging.
// Runs in the side-panel page (has DOMParser; host_permissions + credentials:'include'
// reuse the user's existing IREPS browser session - no credentials are read or stored).

export const SESSION_MSG = 'IREPS session expired. Please log in to IREPS and try again.';

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
export function log(tag, msg) {
  const line = `[DocLink][${tag}] ${redact(msg)}`;
  console.log(line);
  LOG_TAIL.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (LOG_TAIL.length > 400) LOG_TAIL.shift();
}

/** Recent (already redacted) log lines, for the "Copy diagnostics" button. */
export const getLogTail = () => LOG_TAIL.join('\n');

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const fileSafe = (s) => String(s ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_') || 'NA';

export async function getBaseUrl() {
  const cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
  const base = cfg.target === 'mock' ? cfg.mockBaseUrl : cfg.realBaseUrl;
  return String(base).replace(/\/+$/, '');
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
  const n = Math.min(bytes.length - 3, 1024);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

/**
 * Financial / Commercial / Techno-Commercial Tabulation are OUT OF SCOPE for the tender feature.
 * They live next to "My Offer" on commTboPdfAction.do (pdfType=...), so the guard sits at the
 * lowest request layer: nothing in this module can reach those endpoints, even by mistake.
 */
export function isExcludedUrl(url) {
  let u;
  try {
    u = new URL(url, 'https://x.invalid/');
  } catch {
    return false;
  }
  if (/commTboPdfAction\.do/i.test(u.pathname)) {
    const t = [...u.searchParams].find(([k]) => k.toLowerCase() === 'pdftype')?.[1] || '';
    return t.toLowerCase() !== 'offer';
  }
  return /tabulation|fin-?tab|tech-?tab/i.test(u.pathname + u.search);
}

/** Authenticated request. `form` is an object / URLSearchParams (body for POST, query for GET). */
export const fetchSettings = { timeoutMs: 45000, waitMs: 180000, waitRetryMs: 5000, waitRetryMaxMs: 60000 };

/** IREPS answers these while a page is still coming up (gateway / overloaded); worth waiting out. */
const STILL_OPENING = new Set([502, 503, 504]);

/**
 * `wait` (Negotiation / Counter Offer): DocLink waits up to fetchSettings.waitMs (3 minutes) for IREPS to open
 * the page. Within that time a slow answer is waited for, and while IREPS cannot be reached or answers
 * 502/503/504 the request is retried with backoff (5s, 10s ... 60s); after it, the page fails as not responding.
 * `wait = { what, onWait(msg) }` names the page for the progress line.
 */
export async function irepsFetch(base, ref, opts = {}) {
  const { wait = null } = opts;
  if (!wait) return irepsFetchOnce(base, ref, opts);
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

async function irepsFetchOnce(base, ref, { method = 'GET', form = null, relativeTo, timeoutMs = fetchSettings.timeoutMs } = {}) {
  let url = absUrl(base, ref, relativeTo);
  if (isExcludedUrl(url)) throw new TenderError('EXCLUDED', 'Financial/Commercial Tabulation downloads are excluded from DocLink tender downloads.');
  const init = { method, credentials: 'include', redirect: 'follow', headers: {} };
  if (form) {
    const params = form instanceof URLSearchParams ? form : new URLSearchParams(form);
    if (method === 'GET') {
      const u = new URL(url);
      for (const [k, v] of params) u.searchParams.set(k, v);
      url = u.toString();
    } else {
      init.body = params.toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
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
  const t = res.text().slice(0, 300000);
  if (/session\s*(has\s*)?(expired|timed\s*out)/i.test(t)) return true;
  // the real IREPS login page: <title>Log into IREPS</title> + <form name="LogonForm" action=".../userLoginAction.do">
  if (/<title>\s*(log\s*into\s*ireps|sign\s*in)/i.test(t)) return true;
  if ((/<form[^>]+name=["']?LogonForm/i.test(t) || /<form[^>]+action=["'][^"']*userLogin(?:Action)?\.do/i.test(t)) && !/welcomeLabel/i.test(t)) return true;
  return /userLogin\.do/i.test(t) && /sign\s*in/i.test(t) && !/log\s*out/i.test(t);
}

export function assertSession(res) {
  if (isLoginResponse(res)) throw new TenderError('SESSION_EXPIRED', SESSION_MSG);
}

export const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

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
      const first = c.args.find((a) => URLISH.test(a));
      if (first) addReq(first, post ? 'POST' : 'GET', { fn: c.fn, args: c.args });
    }
    // anything URL-shaped that parseCalls did not classify (e.g. nested handlers)
    for (const m of (href + ' ' + onclick).matchAll(/['"]([^'"\s]*?(?:\.do|\.pdf)[^'"\s]*)['"]/gi)) {
      if (!reqs.some((r) => r.url === m[1])) addReq(m[1], 'GET', { fn: 'other' });
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

function docCandidates(doc, pageUrl, base, allowAnyFile) {
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
  const inline = [...doc.querySelectorAll('[onclick]')].map((e) => e.getAttribute('onclick')).join(' ') +
    ' ' + [...doc.querySelectorAll('script:not([src])')].map((s) => s.textContent).join(' ');
  for (const m of inline.matchAll(new RegExp(`['"]([^'"\\s]*\\.${ext}(?:\\?[^'"\\s]*)?)['"]`, 'gi'))) raw.push(m[1]);
  const out = [];
  for (const r of raw) {
    try {
      const u = absUrl(base, r, pageUrl);
      if (!isExcludedUrl(u) && !out.includes(u)) out.push(u);
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
 *   -> { kind:'html', html, bytes, ext:'.pdf', converted:true }     print-ready HTML (+ locally rendered text PDF)
 * Throws SESSION_EXPIRED for login pages; NO_DOCUMENT when nothing usable is found.
 * A login / error page is never returned as a document.
 */
export async function resolveIrepsDocument(base, res, { allowHtml = true, allowAnyFile = false, nameHint = '', depth = 0, wait = null } = {}) {
  assertSession(res);
  if (res.status !== 200) throw new TenderError('HTTP', `IREPS returned HTTP ${res.status}.`);
  const kind = sniffKind(res.bytes);
  if (kind === 'empty') throw new TenderError('EMPTY', 'IREPS returned an empty response.');
  const meta = { httpStatus: res.status, contentType: res.contentType };
  if (kind === 'pdf') return { kind: 'file', bytes: res.bytes, ext: '.pdf', converted: false, ...meta };
  if (allowAnyFile && BINARY_DOC_KINDS.has(kind)) {
    return { kind: 'file', bytes: res.bytes, ext: extensionFor(kind, res, nameHint), converted: false, ...meta };
  }
  if (kind !== 'html' && kind !== 'text') {
    throw new TenderError('NOT_DOCUMENT', `IREPS returned an unrecognised file type (${res.contentType || 'unknown'}).`);
  }

  const html = res.text();
  const doc = parseHtml(html);

  for (const url of docCandidates(doc, res.url, base, allowAnyFile)) {
    const r = await irepsFetch(base, url, { wait });
    assertSession(r);
    const k = sniffKind(r.bytes);
    if (r.status === 200 && (k === 'pdf' || (allowAnyFile && BINARY_DOC_KINDS.has(k)))) {
      return { kind: 'file', bytes: r.bytes, ext: extensionFor(k, r, url), converted: false, httpStatus: r.status, contentType: r.contentType };
    }
  }

  if (depth < 1) {
    const next = metaRedirect(doc, html);
    if (next) {
      const r = await irepsFetch(base, next, { relativeTo: res.url, wait });
      return resolveIrepsDocument(base, r, { allowHtml, allowAnyFile, nameHint, depth: depth + 1, wait });
    }
  }

  if (!allowHtml) throw new TenderError('NO_DOCUMENT', 'IREPS did not return a document file (only a web page).');
  const bad = looksLikeErrorPage(doc);
  if (bad) throw new TenderError('NO_DOCUMENT', bad);
  const lines = htmlToLines(doc);
  if (!lines.length) throw new TenderError('NO_DOCUMENT', 'The IREPS page had no readable content.');
  return { kind: 'html', html, bytes: buildPdf(wrapLines(lines)), ext: '.pdf', converted: true, ...meta };
}

/**
 * Issue the request exactly as the IREPS page would (req = { method, url, form, relativeTo })
 * and resolve the response into a validated document.
 */
export async function fetchDocument(base, req, opts = {}) {
  const res = await irepsFetch(base, req.url, { method: req.method || 'GET', form: req.form || null, relativeTo: req.relativeTo, wait: req.wait || null });
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

const CHAR_MAP = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '•': '*', '₹': 'Rs.', '…': '...' };
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
 * Names are unique within a run (no silent overwrite) and every path is sanitised.
 */
export function createSaver({ accountLabel, tenderNo, subPath = null, conflict = 'uniquify' }) {
  // `subPath` (e.g. ['Correspondence','Pending',<tenderNo>]) replaces the default Tender_<no> folder.
  const root = subPath
    ? [DOWNLOAD_ROOT, safeSegment(accountLabel), ...subPath.map((p) => safeSegment(p))].join('/')
    : `${DOWNLOAD_ROOT}/${safeSegment(accountLabel)}/Tender_${safeSegment(tenderNo)}`;
  const used = new Set();

  function uniquePath(subdir, fileName) {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    const dir = subdir ? `${safeSegment(subdir)}/` : '';
    let name = `${safeSegment(stem, 120)}${ext.replace(/[^.\w]/g, '')}`;
    for (let n = 2; used.has(`${dir}${name}`.toLowerCase()); n++) name = `${safeSegment(stem, 120)}_${n}${ext.replace(/[^.\w]/g, '')}`;
    used.add(`${dir}${name}`.toLowerCase());
    return `${dir}${name}`;
  }

  async function save(subdir, fileName, bytes, mime) {
    if (!bytes || !bytes.length) throw new TenderError('EMPTY', 'Refusing to save an empty file.');
    const ext = (/\.[A-Za-z0-9]+$/.exec(fileName) || [''])[0].toLowerCase();
    if (ext === '.pdf' && !isPdfBytes(bytes)) throw new TenderError('NOT_PDF', 'Refusing to save a non-PDF payload as .pdf.');
    if (ext !== '.html' && ext !== '.txt' && ext !== '.json' && sniffKind(bytes) === 'html') {
      throw new TenderError('NOT_DOCUMENT', 'Refusing to save a web page as a document file.');
    }
    const rel = uniquePath(subdir, fileName);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || MIME[ext] || 'application/octet-stream' }));
    try {
      const id = await chrome.downloads.download({ url, filename: `${root}/${rel}`, conflictAction: conflict, saveAs: false });
      await waitForDownload(id);
      log('Download', `File saved ${rel}`);
      return { relPath: rel, downloadId: id, size: bytes.length };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { root, save };
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

