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
// The guard reads a POST's body as the server would (a form, JSON or multipart); a body CDP does not hand over
// is read through CDP, and one DocLink cannot read is refused (10.4). The page cannot open a window of its own,
// whose requests no guard would see: window.open gives nothing and a form or link aimed at a new window is
// dropped (QUIET_PAGE); a window it opens anyway is closed the moment Chrome reports it.
// A print tab still open when the side panel closes is stopped, detached and closed.
//
// The worker is told the print tab's id before its page loads (NOTE_OWN_TAB): an IREPS page loading in a tab
// DocLink opened itself is never taken as the user being active on IREPS (background/scheduler-job.js), so a
// print never wakes the scheduler or keeps the IREPS session alive.

import { TenderError, log, noteOwnTab, requestRefusal } from './tender-core.js';
import { MESSAGE_TYPES, TARGETS } from '../utils/messages.js';

/** Ctrl+P "Save as PDF" as the user gets it: A4, Chrome's default margins, table shading kept, no date/URL header. */
export const PRINT_OPTIONS = { paperWidth: 8.27, paperHeight: 11.69, printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true };

/** loadWaitMs: how long the page's CSS/images may take before printing anyway; printWaitMs: the print itself. */
export const printSettings = { loadWaitMs: 30000, printWaitMs: 60000 };

/**
 * The letter's own scripts must not stop the print: no print dialog, no alert / confirm boxes.
 * confirm() answers "Cancel", never "OK": the tab carries the user's IREPS session, and an
 * auto-approved "Are you sure?" could let a page script submit something (DocLink is read-only).
 * Nor may they open a window (10.4): a window is a tab of its own that DocLink's debugger does not see, so its
 * requests would pass no guard. window.open gives null, as when Chrome's popup blocker stops it, and a form sent
 * or a link followed into a new window (target _blank, or a name that is no frame of the page; IREPS's
 * postRequestNewWindow posts a form into a window it named) is dropped. A form or link aimed at the page itself
 * or at one of its frames goes on as before.
 */
const QUIET_PAGE = [
  'window.print=function(){};window.alert=function(){};window.confirm=function(){return false;};window.prompt=function(){return null;};',
  'window.open=function(){return null;};',
  '(function(){',
  '  var framed=function(name){',
  '    var look=function(doc){',
  '      if(!doc)return false;',
  '      var els=doc.querySelectorAll("iframe,frame");',
  '      for(var i=0;i<els.length;i++){',
  '        if(els[i].getAttribute("name")===name)return true;',
  '        try{if(look(els[i].contentDocument))return true;}catch(e){}',
  '      }',
  '      return false;',
  '    };',
  '    try{if(window.top.name===name)return true;return look(window.top.document);}catch(e){return look(document);}',
  '  };',
  '  var newWindow=function(el,submitter){',
  '    var t=(submitter&&submitter.getAttribute&&submitter.getAttribute("formtarget"))||(el&&el.getAttribute&&el.getAttribute("target"))||"";',
  '    if(!t){var b=el&&el.ownerDocument&&el.ownerDocument.querySelector("base[target]");t=b?b.getAttribute("target"):"";}',
  '    t=String(t).trim();var k=t.toLowerCase();',
  '    if(!k||k==="_self"||k==="_parent"||k==="_top")return false;',
  '    return k==="_blank"||!framed(t);',
  '  };',
  '  window.addEventListener("submit",function(e){if(newWindow(e.target,e.submitter))e.preventDefault();},true);',
  '  window.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href],area[href]"):null;if(a&&newWindow(a))e.preventDefault();},true);',
  '  if(window.HTMLFormElement){var submit=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){if(!newWindow(this))return submit.call(this);};}',
  '})();',
].join('\n');

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
 * `postData` is the body as the tab sends it (pausedBody); null: the tab sends a body DocLink could not read (a
 * file or a stream), which no guard can check, so that request is refused (10.4).
 */
export function printRequestRefusal({ method = 'GET', url = '', postData = '' }) {
  if (!/^https?:/i.test(url)) return '';
  const verb = String(method || 'GET').toUpperCase();
  // HEAD / OPTIONS read like a GET; PUT, DELETE, PATCH ... are refused by the guard as they are
  const asMethod = verb === 'HEAD' || verb === 'OPTIONS' ? 'GET' : verb;
  if (postData === null && asMethod !== 'GET') return `the page sent ${shortUrl(url)} a body DocLink could not read, so it could not be checked`;
  const r = requestRefusal({ method: asMethod, url, body: asMethod === 'POST' ? postData || null : null });
  return r && r.code === 'BLOCKED' ? `the page asked for ${shortUrl(url)}: ${r.message}` : '';
}

/**
 * The body of a paused request of the print tab, as the server gets it (10.4): CDP's postData, else its
 * postDataEntries, else what Network.getRequestPostData reads; '' for a request without a body; null when the tab
 * sends a body none of these gives (a file or a stream), which printRequestRefusal refuses.
 */
export async function pausedBody(params, send) {
  const request = params.request || {};
  if (typeof request.postData === 'string') return request.postData;
  const entries = Array.isArray(request.postDataEntries) ? request.postDataEntries : [];
  if (entries.length && entries.every((e) => typeof e?.bytes === 'string')) return entries.map((e) => bodyText(fromBase64(e.bytes))).join('');
  if (!request.hasPostData && !entries.length) return '';
  if (params.networkId) {
    try {
      const got = await send('Network.getRequestPostData', { requestId: params.networkId });
      if (typeof got?.postData === 'string') return got.base64Encoded ? bodyText(fromBase64(got.postData)) : got.postData;
    } catch {
      /* not readable through CDP either */
    }
  }
  return null;
}

const bodyText = (bytes) => new TextDecoder().decode(bytes);

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
  await tellWorkerOwnTab(tab.id);
  const target = { tabId: tab.id };
  const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  const want = url.split('#')[0];
  let attached = false;
  let detached = '';
  // the answer to the tab's request for the letter (Fetch.fulfillRequest), given once: settles with true when the
  // tab got the page, else with why not. A tab that did not get it shows a blank or error page, which is never
  // printed as the letter: the letter fails as PRINT and the caller keeps its text rendering (10.3)
  let handed = null;
  let onLoaded;
  const loaded = new Promise((r) => { onLoaded = r; });
  openTabs.set(tab.id, () => { attached = false; detached = 'the side panel was closed'; onLoaded(); });

  /** A paused request of the tab: the letter itself is answered from memory, any other request passes the guard. */
  const answer = async (params) => {
    const request = params.request || {};
    const isDocument = !params.resourceType || params.resourceType === 'Document';
    // only the letter itself is answered from memory; a frame inside it is fetched from IREPS as usual
    if (!handed && isDocument && String(request.url).split('#')[0] === want) {
      handed = send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: contentType || 'text/html' }],
        body: toBase64(bytes),
      }).then(() => true, (e) => {
        log('Print', `Could not hand the page to the tab: ${e.message}`, 'warn');
        return e.message || 'Chrome did not take it';
      });
      if ((await handed) !== true) onLoaded(); // the letter will not load: stop waiting for it
      return;
    }
    // a request the write guard refuses is failed, on its body as sent (10.4); everything else goes on as before (M20)
    let why;
    try {
      why = printRequestRefusal({ method: request.method, url: String(request.url || ''), postData: await pausedBody(params, send) });
    } catch (e) {
      why = `the page asked for ${shortUrl(String(request.url || ''))}, which could not be checked (${e.message})`;
    }
    if (why) {
      log('Print', `Refused: ${why}`, 'warn');
      await send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    } else {
      await send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
    }
  };
  const onEvent = (src, method, params) => {
    if (src.tabId !== tab.id) return;
    if (method === 'Fetch.requestPaused') {
      answer(params).catch((e) => log('Print', `A request of the print tab was not answered: ${e.message}`, 'warn'));
    } else if (method === 'Page.javascriptDialogOpening') {
      // close alerts / leave-page boxes; Cancel anything that asks for consent or input (read-only)
      const accept = params.type === 'alert' || params.type === 'beforeunload';
      send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    } else if (method === 'Page.loadEventFired' && handed) {
      onLoaded();
    }
  };
  const onDetach = (src, reason) => {
    if (src.tabId !== tab.id) return;
    attached = false;
    detached = reason || 'detached';
    onLoaded();
  };
  // a window the letter page opens all the same (QUIET_PAGE drops the usual ways) is a tab no guard sees: closed at once
  const onTabCreated = (t) => {
    if (!t || t.openerTabId !== tab.id) return;
    noteOwnTab(t.id);
    log('Print', 'Closed a window the letter page opened', 'warn');
    Promise.resolve(chrome.tabs.remove(t.id)).catch(() => {});
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  chrome.tabs.onCreated?.addListener(onTabCreated);
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
    if (!handed) throw new TenderError('PRINT', 'The letter page did not open in the print tab.');
    const given = (await within(handed, printSettings.printWaitMs)) ? await handed : 'Chrome did not answer';
    if (given !== true) throw new TenderError('PRINT', `The letter page could not be handed to the print tab (${given}).`);
    const printing = send('Page.printToPDF', PRINT_OPTIONS);
    if (!(await within(printing, printSettings.printWaitMs))) throw new TenderError('PRINT', `Chrome did not finish printing within ${printSettings.printWaitMs / 1000}s.`);
    const pdf = fromBase64((await printing).data);
    log('Print', `Printed ${new URL(want).pathname} to PDF (${pdf.length} bytes)`);
    return pdf;
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    chrome.tabs.onCreated?.removeListener(onTabCreated);
    const stillOpen = openTabs.delete(tab.id); // false: closePrintTabs already closed it
    if (attached && stillOpen) await chrome.debugger.detach(target).catch(() => {});
    if (stillOpen) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** How long a print waits for the worker to note its tab (it prints anyway after that). */
const OWN_TAB_NOTE_WAIT_MS = 2000;

/**
 * Tell the worker the print tab is DocLink's own, and wait (briefly) until it has noted it, so the tab's
 * IREPS page load that follows is never counted as the user's IREPS activity. Printing never fails because of it.
 */
async function tellWorkerOwnTab(tabId) {
  if (!chrome.runtime?.sendMessage) return;
  try {
    const noted = await within(chrome.runtime.sendMessage({ target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.NOTE_OWN_TAB, tabId }), OWN_TAB_NOTE_WAIT_MS);
    if (!noted) log('Print', 'The worker did not note the print tab in time; printing anyway');
  } catch (e) {
    log('Print', `The worker was not told about the print tab (${e.message}); printing anyway`);
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
