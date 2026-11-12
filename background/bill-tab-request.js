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
  // versioned: a copy injected by an older DocLink must not keep this one from registering
  const VERSION = "2";
  if (globalThis.__doclinkBillTabRequest === VERSION) return;
  globalThis.__doclinkBillTabRequest = VERSION;

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

  /*
   * DOCLINK_TAB_SIGN_PDF { frames }: hand a PDF to the IREPS signing app (eMudhra IREPSSigner,
   * wss://127.0.0.1:2175) the way CRISPKI.js does: send frame 1, and the next frame each time
   * the signer answers "sendmore"; then collect the answer until it contains "completed".
   * The signer shows its own window where the user selects the DSC and enters the PIN.
   * Answers { ok: true, reply } or { ok: false, error, unavailable }.
   */
  const SIGNER_URL = "wss://127.0.0.1:2175/";
  const SIGN_TIMEOUT_MS = 5 * 60 * 1000;

  function signWithSigner(frames) {
    return new Promise((resolve) => {
      let ws;
      let next = 0;
      let reply = "";
      let opened = false;
      let started = false;
      let finished = false;
      let greetTimer = null;
      const log = (...args) => console.info("[DocLink] signer:", ...args);
      // CRISPKI.js sends only after the signer's greeting ("status = success port = 2175 ...");
      // a message sent before it is ignored by the signer
      const start = (why) => {
        if (started || finished) return;
        started = true;
        clearTimeout(greetTimer);
        log(`${why}; sending the PDF (${frames.length} frame(s)) - the signer window should open now`);
        ws.send(frames[next++]);
      };
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(greetTimer);
        log(result.ok ? "answer received" : `stopped: ${result.error}`);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "no answer from the signer within 5 minutes" }), SIGN_TIMEOUT_MS);
      try {
        ws = new WebSocket(SIGNER_URL);
      } catch (error) {
        finish({ ok: false, unavailable: true, error: String((error && error.message) || error) });
        return;
      }
      log(`connecting to ${SIGNER_URL}`);
      ws.onopen = () => {
        opened = true;
        log("connected, waiting for the signer's greeting");
        greetTimer = setTimeout(() => start("no greeting within 5 s"), 5000);
      };
      ws.onerror = () => {
        if (!opened) finish({ ok: false, unavailable: true, error: `no signer listening on ${SIGNER_URL}` });
      };
      ws.onclose = () => finish(opened ? { ok: false, error: "the signer closed the connection before answering" } : { ok: false, unavailable: true, error: `no signer listening on ${SIGNER_URL}` });
      ws.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        if (data.indexOf("subProtocol") !== -1) return;
        if (!started) {
          if (/status\s*=\s*success/i.test(data)) start(`greeting: ${data.trim()}`);
          else log(`unexpected message before sending: ${data.slice(0, 120)}`);
          return;
        }
        if (data === "sendmore") {
          if (next < frames.length) {
            log(`sendmore -> frame ${next + 1}/${frames.length}`);
            ws.send(frames[next++]);
          }
          return;
        }
        if (!reply) log(`answer started: ${data.slice(0, 40).replace(/[A-Za-z0-9+/=]{20,}/g, "<data>")}`);
        reply += data;
        if (reply.indexOf("completed") !== -1) finish({ ok: true, reply });
      };
    });
  }

  /*
   * DOCLINK_TAB_SAVE_FILE { relativeDir, pdfName, pdfContent }: store a signed PDF the way the
   * page's crispki_upform does (POST /cgi-bin/save.php, multipart, no file picked). Answers
   * { ok: true, status, text } or { ok: false, error }.
   */
  async function saveFile(message) {
    const form = new FormData();
    form.append("app_name", "ireps");
    form.append("request_from", "");
    form.append("relative_dir", message.relativeDir);
    form.append("isBid", "N");
    form.append("upfilename", "upFile");
    form.append("savename", "");
    form.append("docSize", "");
    form.append("pdfContent", message.pdfContent);
    form.append("pdfName", message.pdfName);
    form.append("upFile", new Blob([], { type: "application/octet-stream" }), "");
    const response = await fetch(new URL("/cgi-bin/save.php", location.origin).href, { method: "POST", body: form, credentials: "include", cache: "no-store" });
    return { ok: true, status: response.status, text: await response.text() };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message.type !== "DOCLINK_TAB_SIGN_PDF" && message.type !== "DOCLINK_TAB_SAVE_FILE")) return false;
    (async () => {
      try {
        if (message.type === "DOCLINK_TAB_SIGN_PDF") {
          if (!Array.isArray(message.frames) || !message.frames.length) throw new Error("nothing to sign");
          sendResponse(await signWithSigner(message.frames));
        } else {
          sendResponse(await saveFile(message));
        }
      } catch (error) {
        sendResponse({ ok: false, error: String((error && error.message) || error) });
      }
    })();
    return true;
  });
})();
