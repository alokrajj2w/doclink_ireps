// Chrome's own "Print -> Save as PDF" (Ctrl+P) for IREPS letters that exist only as web pages.
// IREPS does not keep published letters (LOA, Negotiation, Counter Offer, Correspondence) as files: every
// view builds them as HTML. DocLink has already fetched that HTML (for the LOA after the "viewed" call,
// always with the user's session). Here it is opened in a background tab at its
// real IREPS address - the tab's request for the page is answered with those bytes, so IREPS is not asked
// for the letter a second time - and printed with Page.printToPDF, the engine behind Ctrl+P. The page's
// CSS and images load from IREPS as they would on screen.
//
// Needs the "debugger" permission. While a letter prints Chrome shows "DocLink started debugging this
// browser"; the tab is closed straight after. When the debugger cannot be used (blocked by policy, the bar
// cancelled) the caller keeps the text-only PDF.

import { TenderError, log } from './tender-core.js';

/** Ctrl+P "Save as PDF" as the user gets it: A4, Chrome's default margins, table shading kept, no date/URL header. */
export const PRINT_OPTIONS = { paperWidth: 8.27, paperHeight: 11.69, printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true };

/** loadWaitMs: how long the page's CSS/images may take before printing anyway; printWaitMs: the print itself. */
export const printSettings = { loadWaitMs: 30000, printWaitMs: 60000 };

/** The letter's own scripts must not stop the print: no print dialog, no alert / confirm boxes. */
const QUIET_PAGE = 'window.print=function(){};window.alert=function(){};window.confirm=function(){return true;};window.prompt=function(){return null;};';

export const canPrintPages = () => typeof chrome !== 'undefined' && !!chrome.debugger?.attach && !!chrome.tabs?.create;

let queue = Promise.resolve();

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
  const target = { tabId: tab.id };
  const send = (method, params = {}) => chrome.debugger.sendCommand(target, method, params);
  const want = url.split('#')[0];
  let attached = false;
  let detached = '';
  let served = false;
  let onLoaded;
  const loaded = new Promise((r) => { onLoaded = r; });

  const onEvent = (src, method, params) => {
    if (src.tabId !== tab.id) return;
    if (method === 'Fetch.requestPaused') {
      // only the letter itself is answered from memory; a frame inside it is fetched from IREPS as usual
      if (!served && params.request.url.split('#')[0] === want) {
        served = true;
        send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: contentType || 'text/html' }],
          body: toBase64(bytes),
        }).catch((e) => log('Print', `Could not hand the page to the tab: ${e.message}`));
      } else {
        send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      }
    } else if (method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
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
    if (attached) await chrome.debugger.detach(target).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
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
