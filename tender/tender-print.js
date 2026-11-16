// Chrome's own "Print -> Save as PDF" (Ctrl+P) for IREPS letters that exist only as web pages.
// IREPS does not keep published letters (LOA, Negotiation, Counter Offer, Correspondence) or published
// corrigenda (supply/viewCorrigendum.do) as files: every
// view builds them as HTML. DocLink has already fetched that HTML (for the LOA after the "viewed" call,
// always with the user's session). Here it is opened in a background tab at its
// real IREPS address - the tab's request for the page is answered with those bytes, so IREPS is not asked
// for the letter a second time - and printed with Page.printToPDF, the engine behind Ctrl+P. The page's
// CSS and images load from IREPS as they would on screen.
//
// Needs the "debugger" permission. While a letter prints Chrome shows "DocLink started debugging this
// browser"; the tab is closed straight after. When the debugger cannot be used (blocked by policy, the bar
// cancelled) the caller keeps the text-only PDF.
//
// The letter's own scripts run in that tab with the user's IREPS session (M20). Every request the tab makes is
// seen (Fetch domain), and only one the write guard refuses - a page or action that names a write (submit,
// save, update, delete, withdraw, approve, logout ...; tender-core.js requestRefusal, code BLOCKED) - is
// failed. Every other request, GET or POST, goes on exactly as before, so what is printed does not change.
// A print tab still open when the side panel closes is stopped, detached and closed.

import { TenderError, log, noteOwnTab, requestRefusal } from './tender-core.js';

/** Ctrl+P "Save as PDF" as the user gets it: A4, Chrome's default margins, table shading kept, no date/URL header. */
export const PRINT_OPTIONS = { paperWidth: 8.27, paperHeight: 11.69, printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true };

/** loadWaitMs: how long the page's CSS/images may take before printing anyway; printWaitMs: the print itself. */
export const printSettings = { loadWaitMs: 30000, printWaitMs: 60000 };

/**
 * The letter's own scripts must not stop the print: no print dialog, no alert / confirm boxes.
 * confirm() answers "Cancel", never "OK": the tab carries the user's IREPS session, and an
 * auto-approved "Are you sure?" could let a page script submit something (DocLink is read-only).
 */
const QUIET_PAGE = 'window.print=function(){};window.alert=function(){};window.confirm=function(){return false;};window.prompt=function(){return null;};';

export const canPrintPages = () => typeof chrome !== 'undefined' && !!chrome.debugger?.attach && !!chrome.tabs?.create;

let queue = Promise.resolve();

/** Print tabs still open (one at a time, see the queue): tab id -> stop(), the print waiting on it. */
const openTabs = new Map();

/**
 * Stop every print still going, detach from its tab and close it. Called when the side panel is closed or
 * reloaded (pagehide), so no IREPS letter is left in a background tab under the debugger. -> Promise
 */
export function closePrintTabs() {
  const tabs = [...openTabs];
  openTabs.clear();
  return Promise.all(tabs.map(async ([id, stop]) => {
    stop();
    try { await chrome.debugger?.detach?.({ tabId: id }); } catch { /* not attached any more */ }
    try { await chrome.tabs?.remove?.(id); } catch { /* already closed */ }
    log('Print', 'Closed a print tab that was still open');
  }));
}
globalThis.addEventListener?.('pagehide', () => { closePrintTabs(); });

/**
 * Why the print tab must not make this request, or '' (M20): only a request the write guard refuses (code
 * BLOCKED: a write action, logout ...), whatever its method. Every other request - the page's CSS, images,
 * frames, scripts, and any GET or POST it needs to show the letter - goes on unchanged.
 */
export function printRequestRefusal({ method = 'GET', url = '', postData = '' }) {
  if (!/^https?:/i.test(url)) return '';
  const verb = String(method || 'GET').toUpperCase();
  // HEAD / OPTIONS read like a GET; PUT, DELETE, PATCH ... are refused by the guard as they are
  const asMethod = verb === 'HEAD' || verb === 'OPTIONS' ? 'GET' : verb;
  const r = requestRefusal({ method: asMethod, url, body: asMethod === 'POST' ? postData || null : null });
  return r && r.code === 'BLOCKED' ? `the page asked for ${shortUrl(url)}: ${r.message}` : '';
}

const shortUrl = (url) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return String(url).slice(0, 80); } };

/**
 * Print a fetched IREPS page to PDF exactly as Chrome would. One page at a time (one tab, one debugger session).
 *   page = { url, bytes, contentType }  - the response DocLink already holds
 *   -> Uint8Array (PDF)
 */
export function printPageToPdf(page) {
  const job = queue.then(() => printOnce(page));
  queue = job.catch(() => {});
  return job;
}

async function printOnce({ url, bytes, contentType }) {
  if (!canPrintPages()) throw new TenderError('PRINT_UNAVAILABLE', 'Chrome printing is not available to DocLink (the "debugger" permission is missing).');
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  noteOwnTab(tab.id); // a tab its page opens is DocLink's own too (view-common.js guardTabs)
  const target = { tabId: tab.id };
  const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  const want = url.split('#')[0];
  let attached = false;
  let detached = '';
  let served = false;
  let onLoaded;
  const loaded = new Promise((r) => { onLoaded = r; });
  openTabs.set(tab.id, () => { attached = false; detached = 'the side panel was closed'; onLoaded(); });

  const onEvent = (src, method, params) => {
    if (src.tabId !== tab.id) return;
    if (method === 'Fetch.requestPaused') {
      const request = params.request || {};
      const isDocument = !params.resourceType || params.resourceType === 'Document';
      // only the letter itself is answered from memory; a frame inside it is fetched from IREPS as usual
      if (!served && isDocument && String(request.url).split('#')[0] === want) {
        served = true;
        send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: contentType || 'text/html' }],
          body: toBase64(bytes),
        }).catch((e) => log('Print', `Could not hand the page to the tab: ${e.message}`));
        return;
      }
      // a request the write guard refuses is failed; everything else goes on as before (M20)
      const why = printRequestRefusal({ method: request.method, url: String(request.url || ''), postData: request.postData });
      if (why) {
        log('Print', `Refused: ${why}`, 'warn');
        send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      } else {
        send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      // close alerts / leave-page boxes; Cancel anything that asks for consent or input (read-only)
      const accept = params.type === 'alert' || params.type === 'beforeunload';
      send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    } else if (method === 'Page.loadEventFired' && served) {
      onLoaded();
    }
  };
  const onDetach = (src, reason) => {
    if (src.tabId !== tab.id) return;
    attached = false;
    detached = reason || 'detached';
    onLoaded();
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  try {
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      throw new TenderError('PRINT_UNAVAILABLE', `Chrome did not let DocLink print the page (${e.message}).`);
    }
    attached = true;
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: QUIET_PAGE });
    // every request of the tab, of any type (document, XHR, fetch, beacon, image...), passes onEvent (M20)
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await send('Page.navigate', { url: want });
    if (!(await within(loaded, printSettings.loadWaitMs))) log('Print', `The page was still loading after ${printSettings.loadWaitMs / 1000}s; printing it as it is`);
    if (!attached) throw new TenderError('PRINT', `Printing stopped (${detached === 'canceled_by_user' ? 'the "DocLink started debugging this browser" bar was cancelled' : detached}).`);
    if (!served) throw new TenderError('PRINT', 'The letter page did not open in the print tab.');
    const printing = send('Page.printToPDF', PRINT_OPTIONS);
    if (!(await within(printing, printSettings.printWaitMs))) throw new TenderError('PRINT', `Chrome did not finish printing within ${printSettings.printWaitMs / 1000}s.`);
    const pdf = fromBase64((await printing).data);
    log('Print', `Printed ${new URL(want).pathname} to PDF (${pdf.length} bytes)`);
    return pdf;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    const stillOpen = openTabs.delete(tab.id); // false: closePrintTabs already closed it
    if (attached && stillOpen) await chrome.debugger.detach(target).catch(() => {});
    if (stillOpen) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** true when `p` settles in time (its rejection is passed on), false on timeout. */
function within(p, ms) {
  let timer;
  const late = new Promise((r) => { timer = setTimeout(() => r(false), ms); });
  return Promise.race([p.then(() => true), late]).finally(() => clearTimeout(timer));
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
