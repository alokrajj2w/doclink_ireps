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
