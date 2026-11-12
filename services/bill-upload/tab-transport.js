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
 * so services/ireps-api.js requestIreps() takes it as deps.fetch unchanged.
 */

import { IREPS_CONFIG, IrepsError } from "../ireps-api.js";
import { BILL_ERROR } from "./bill-upload-api.js";
import { logger } from "../../utils/logger.js";

const CONTENT_SCRIPT = "background/bill-tab-request.js";

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
    let result;
    try {
      // idempotent: the script registers its listener once per page
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
      result = await chrome.tabs.sendMessage(tabId, {
        type: "DOCLINK_TAB_FETCH",
        url: String(url),
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body === undefined || init.body === null ? null : String(init.body)
      });
    } catch (error) {
      // the tab navigated away / was closed / is not scriptable
      throw new TypeError(`the IREPS tab could not run the request: ${(error && error.message) || error}`);
    }
    if (!result || !result.ok) throw new TypeError((result && result.error) || "no answer from the IREPS tab");
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
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    return await chrome.tabs.sendMessage(tabId, message);
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
