/**
 * A fetch() that runs inside the user's IREPS tab (chrome.scripting, isolated world) instead
 * of the service worker, for the bill upload's /epsn/ct/* calls (upload.md section 10: "Run
 * the write calls from the IREPS tab"). The requests then leave from the portal's own origin
 * with its Referer, like the bill page's jQuery posts, rather than from chrome-extension://.
 * The session cookie is attached by Chrome as for every other DocLink request; DocLink never
 * sees it.
 *
 * The request itself is made by background/bill-tab-request.js, a small content script
 * injected as a file (a function serialised from here would break once the build has
 * obfuscated it) and asked with chrome.tabs.sendMessage.
 *
 * Only the response status, URL, content type and text come back. Same signature as fetch()
 * so services/ireps-api.js requestIreps() takes it as deps.fetch unchanged, including its
 * deadline: when init.signal aborts (IREPS_CONFIG.timeoutMs), the request ends with an
 * AbortError at once and the tab is told to cancel its fetch (review 3.8).
 */

import { IREPS_CONFIG, IrepsError } from "../ireps-api.js";
import { BILL_ERROR } from "./bill-upload-api.js";
import { logger } from "../../utils/logger.js";

const CONTENT_SCRIPT = "background/bill-tab-request.js";

/**
 * Tabs the script was injected into, as tab id -> the injection's promise. The script stays in
 * the page until the page is reloaded or left, so each tab is injected once (and once more after
 * the service worker restarted, which empties this map; the script ignores a second copy). A
 * page that lost the script is noticed when a message finds no receiver, which Chrome reports
 * without delivering it, and only then is the script injected again (review L14).
 */
const injectedTabs = new Map();

/** Chrome's answer when no script in the tab listens: the message was never delivered. */
const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

/** Numbers the requests, so DOCLINK_TAB_ABORT names the one to cancel. */
let requestSeq = 0;

/**
 * The transport's own failure, a TypeError like fetch()'s network errors (requestIreps reports it
 * as "network"). `tabTransport` says what went wrong, for the bill upload's texts
 * (bill-upload-api.js missingAnswerReason): "tab" = the tab could not run the request or went
 * away before it answered, "fetch" = the page's own fetch failed.
 */
function transportError(text, kind) {
  const error = new TypeError(text);
  error.tabTransport = kind;
  return error;
}

function abortError() {
  return new DOMException("DocLink stopped waiting for IREPS's answer (deadline passed)", "AbortError");
}

/**
 * `promise`, or an AbortError as soon as `signal` aborts; `onAbort` then cancels the request in the
 * tab. A later answer from the tab is dropped.
 */
function untilAborted(promise, signal, onAbort) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortError());
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

/** Ask DocLink's script in the tab to cancel request `id` (nothing is injected for this). */
function cancelInTab(tabId, id) {
  try {
    Promise.resolve(chrome.tabs.sendMessage(tabId, { type: "DOCLINK_TAB_ABORT", id })).catch(() => {});
  } catch {
    // the tab is gone: nothing runs there any more
  }
}

function injectScript(tabId) {
  const pending = chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  injectedTabs.set(tabId, pending);
  // a failed injection is not remembered: the next call tries again
  pending.catch(() => {
    if (injectedTabs.get(tabId) === pending) injectedTabs.delete(tabId);
  });
  return pending;
}

/**
 * Send a message to DocLink's script in the tab, injecting it first if this tab has not got it.
 * Sent again (after a new injection) only when Chrome reports that nothing received it, so a
 * request is never run twice; a message that was delivered and then cut off is not resent.
 * Nothing is sent once `signal` has aborted (the deadline passed while the script was injected).
 */
async function sendToTab(tabId, message, signal = null) {
  for (let attempt = 0; ; attempt++) {
    const injected = injectedTabs.get(tabId) || injectScript(tabId);
    await injected;
    if (signal && signal.aborted) throw abortError();
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      // whatever went wrong, the next message injects first: a page that went away keeps no script
      if (injectedTabs.get(tabId) === injected) injectedTabs.delete(tabId);
      if (attempt > 0 || !NO_RECEIVER.test(String((error && error.message) || error))) throw error;
    }
  }
}

/** Throws BILL_TAB_UNAVAILABLE unless the tab shows the configured IREPS portal. */
export async function assertIrepsTab(tabId) {
  let tab = null;
  try {
    tab = typeof tabId === "number" ? await chrome.tabs.get(tabId) : null;
  } catch {
    tab = null;
  }
  const origin = new URL(IREPS_CONFIG.baseUrl).origin;
  let tabOrigin = "";
  try {
    tabOrigin = tab && tab.url ? new URL(tab.url).origin : "";
  } catch {
    tabOrigin = "";
  }
  if (tabOrigin !== origin) {
    throw new IrepsError(BILL_ERROR.TAB_UNAVAILABLE, "IREPS tab not available", { detail: `keep the IREPS tab (${origin}) open and active while DocLink fills the bill` });
  }
  return tab;
}

/**
 * @param {number} tabId   the IREPS tab the side panel belongs to
 * @returns {typeof fetch}
 */
export function tabFetch(tabId) {
  return async (url, init = {}) => {
    const signal = init.signal || null;
    if (signal && signal.aborted) throw abortError();
    const id = `bill-${Date.now()}-${++requestSeq}`;
    let result;
    try {
      const sent = sendToTab(
        tabId,
        {
          type: "DOCLINK_TAB_FETCH",
          id,
          url: String(url),
          method: init.method || "GET",
          headers: init.headers || {},
          body: init.body === undefined || init.body === null ? null : String(init.body)
        },
        signal
      );
      result = await untilAborted(sent, signal, () => cancelInTab(tabId, id));
    } catch (error) {
      // the deadline passed: requestIreps reports it as a timeout
      if (error && error.name === "AbortError") throw error;
      // the tab navigated away / was closed / is not scriptable
      throw transportError(`the IREPS tab could not run the request: ${(error && error.message) || error}`, "tab");
    }
    if (!result || !result.ok) throw transportError((result && result.error) || "no answer from the IREPS tab", result ? "fetch" : "tab");
    const headers = new Headers(result.contentType ? { "content-type": result.contentType } : {});
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      statusText: result.statusText,
      url: result.url,
      redirected: result.redirected,
      headers,
      text: async () => result.text
    };
  };
}

const STEP_NAME = { DOCLINK_TAB_SIGN_PDF: "signing in the IREPS signer", DOCLINK_TAB_SAVE_FILE: "storing the signed PDF" };

async function askTab(tabId, message) {
  const step = STEP_NAME[message.type] || "the request";
  let pageBefore = "";
  try {
    pageBefore = (await chrome.tabs.get(tabId)).url || "";
  } catch {
    pageBefore = "";
  }
  try {
    return await sendToTab(tabId, message);
  } catch (error) {
    const text = String((error && error.message) || error);
    let pageAfter = "";
    try {
      pageAfter = (await chrome.tabs.get(tabId)).url || "";
    } catch {
      pageAfter = "(tab closed)";
    }
    const path = (u) => (u.startsWith("http") ? new URL(u).pathname : u);
    logger.warn(`Bill upload: the IREPS tab stopped answering during ${step}`, { error: text, pageBefore: path(pageBefore), pageAfter: path(pageAfter) });
    // Chrome closes the channel when the page that runs DocLink's script is reloaded or left
    if (/message channel closed|Receiving end does not exist|context invalidated|back\/forward cache/i.test(text)) {
      const moved = pageAfter && pageBefore && pageAfter !== pageBefore ? ` (it moved from ${path(pageBefore)} to ${path(pageAfter)})` : "";
      throw new IrepsError(BILL_ERROR.TAB_UNAVAILABLE, "IREPS page changed", {
        detail: `the IREPS page was reloaded or left during ${step}${moved}. Leave the IREPS tab on its page until DocLink shows the result (open the bill in IREPS only afterwards), then click Sign & upload again`
      });
    }
    throw new IrepsError(BILL_ERROR.TAB_UNAVAILABLE, "IREPS tab not available", { detail: `the IREPS tab could not be used during ${step}: ${text}` });
  }
}

/**
 * Sign through the IREPS signing app, from the IREPS tab (bill-document-upload.js signPdf).
 * @param {number} tabId
 * @returns {(frames: string[]) => Promise<string>}  the signer's raw answer
 */
export function tabSignPdf(tabId) {
  return async (frames) => {
    // the user may take minutes in the signer (DSC, PIN): keep the service worker alive meanwhile
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
    let result;
    try {
      logger.info(`Bill upload: handing the PDF to the IREPS signer (${frames.length} frame(s)); waiting for the user to sign`);
      result = await askTab(tabId, { type: "DOCLINK_TAB_SIGN_PDF", frames });
    } finally {
      clearInterval(keepAlive);
    }
    logger.info(`Bill upload: signer ${result && result.ok ? "answered" : `failed: ${(result && result.error) || "no answer"}`}`);
    if (result && result.ok) return result.reply;
    if (result && result.unavailable) throw new IrepsError(BILL_ERROR.SIGNER_UNAVAILABLE, "signer not reachable", { detail: result.error });
    throw new IrepsError(BILL_ERROR.SIGN_FAILED, "signing failed", { detail: (result && result.error) || "no answer from the IREPS tab" });
  };
}

/**
 * Store a signed PDF with /cgi-bin/save.php from the IREPS tab (bill-document-upload.js saveFile).
 * @param {number} tabId
 * @returns {(form: { relativeDir: string, pdfName: string, pdfContent: string }) => Promise<string>}  the response text
 */
export function tabSaveFile(tabId) {
  return async (form) => {
    logger.info("Bill upload: storing the signed PDF in IREPS (save.php)", { dir: form.relativeDir, name: form.pdfName });
    const result = await askTab(tabId, { type: "DOCLINK_TAB_SAVE_FILE", ...form });
    if (!result || !result.ok) throw new IrepsError(BILL_ERROR.REQUEST_FAILED, "save.php failed", { detail: `storing the signed PDF failed: ${(result && result.error) || "no answer"}` });
    if (result.status < 200 || result.status >= 300) throw new IrepsError(BILL_ERROR.REQUEST_FAILED, "save.php failed", { status: result.status, detail: `IREPS answered HTTP ${result.status} when storing the signed PDF` });
    return result.text;
  };
}
