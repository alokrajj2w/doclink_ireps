/**
 * Content script (isolated world) injected into the user's IREPS tab by the bill upload
 * (services/bill-upload/tab-transport.js) with chrome.scripting.executeScript({ files }).
 * It sends one bill request from the page's own origin when the service worker asks with
 * chrome.tabs.sendMessage({ type: "DOCLINK_TAB_FETCH", url, method, headers, body }) and
 * answers { ok, status, statusText, url, redirected, contentType, text } or { ok: false, error }.
 *
 * A plain script, copied verbatim into the build (scripts/build.mjs STATIC_FILES): it is
 * injected as a file, never serialised from the obfuscated service worker. Only same-origin
 * IREPS URLs are fetched; the cookie stays with Chrome.
 */
(() => {
  if (globalThis.__doclinkBillTabRequest) return;
  globalThis.__doclinkBillTabRequest = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "DOCLINK_TAB_FETCH") return false;
    (async () => {
      try {
        const url = new URL(message.url, location.href);
        if (url.origin !== location.origin) throw new Error(`refusing ${url.origin} from ${location.origin}`);
        const response = await fetch(url.href, {
          method: message.method || "GET",
          headers: message.headers || {},
          body: message.body === null || message.body === undefined ? undefined : message.body,
          credentials: "include",
          cache: "no-store",
          redirect: "follow"
        });
        sendResponse({
          ok: true,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          redirected: response.redirected,
          contentType: response.headers.get("content-type") || "",
          text: await response.text()
        });
      } catch (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error) });
      }
    })();
    return true; // answered asynchronously
  });
})();
