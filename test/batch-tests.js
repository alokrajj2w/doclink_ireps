/**
 * Browser-side tests for the two batch workflows:
 *   - Download POs by PO date  (services/po/po-date-service.js)
 *   - Download ICs from main-page notifications
 *       (services/notifications/notification-service.js,
 *        services/inspection-certificate/ic-notification-service.js)
 *
 * A small in-memory IREPS simulator answers searchPO.do (showPage + search +
 * page links, with the portal's 180-day limit), vendorInspectionCallList.do
 * (list page, search by PO / PO Sr., navigate() paging), the notification
 * endpoint and the PDF links. Every PO number, call id and path below is
 * invented. Invoked from run-tests.js.
 */

import { runPoDateDownload, retryPoDateFailures, searchPosByDate, validatePoDateSelection, assignPoDatePaths, PO_ITEM_STATUS } from "../services/po/po-date-service.js";
import { runIcNotificationDownload, retryIcNotificationFailures, buildIcManifest, matchIcRows, NOTIFICATION_OUTCOME } from "../services/inspection-certificate/ic-notification-service.js";
import { parseNotificationResponse, selectIcNotifications, parseIcNotification, isIcIssuedNotification } from "../services/notifications/notification-service.js";
import { splitDateRange, withRetry, isoToIrepsDate } from "../services/batch-utils.js";
import { parseIrepsDate, IrepsError } from "../services/ireps-api.js";
import { parsePoSearchResults } from "../services/po/po-parser.js";
import { parseIcSearchResults } from "../services/inspection-certificate/ic-parser.js";
import { buildPoDateDownloadPath } from "../utils/filename.js";

const pdf = (text = "x") => new TextEncoder().encode(`%PDF-1.4\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);

const PO_ROWS_START = "<!-- PO rows from here -->";
const PO_ROWS_END = "<!-- PO rows up to here -->";
const IC_ROWS_START = "<!-- IC rows from here -->";
const IC_ROWS_END = "<!-- IC rows up to here -->";

const day = (text) => parseIrepsDate(text).getTime();
const DAY_MS = 86400000;

/** Build the simulator. `opts` lets a test misbehave in a specific way. */
function simulator({ searchPage, poPage, listPage, icPage, loginPage }, opts = {}) {
  const calls = [];
  const state = { tokens: 0, poWindows: [], icSearches: [], pdfHits: new Map(), expired: false };
  const respond = (body, init = {}) => new Response(body, { status: init.status ?? 200, headers: { "content-type": init.contentType || "text/html; charset=utf-8" } });
  const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

  /* ---- searchPO.do ---- */
  const poRow = (r, i) => `<tr style="line-height: 26px;" class="trPoRow">
    <td class="searchDtlCls">${i}</td><td class="searchDtlCls">${esc(r.unit)}</td>
    <td class="searchDtlCls">${r.link ? `<a href="${r.link}" title="Click to View/Download PO" target="_blank">${esc(r.poNo)} </a>` : esc(r.poNo)}</td>
    <td> ${r.date}</td><td class="searchDtlCls">S</td><td class="searchDtlCls">${r.value || "1000.00"}</td>
    <td class="dataText">${r.link ? `<a title="View/Download PO" class="linkStyle" href="${r.link}" target="_blank">v</a>` : ""}
      <a title="Manage Your Purchase Order" class="linkStyle" href="#" onclick="postRequest('/epsn/dispatchParticulars/x.do')">m</a></td></tr>`;

  const poSearch = (p) => {
    const from = p.get("dateFrom");
    const to = p.get("dateTo");
    const pageNo = Number(p.get("pageNo") || 1);
    const perPage = Number(p.get("recordsPerPage") || 20);
    if (p.get("searchRange") !== "2") return respond(opts.wrongRange ? "wrong" : "unexpected searchRange", { status: 400 });
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(from || "") || !/^\d{2}\/\d{2}\/\d{4}$/.test(to || "")) return respond("bad dates", { status: 400 });
    if (p.get("searchCriteria") !== null && p.getAll("searchCriteria")[0] !== "PO" && p.has("org.apache.struts.taglib.html.TOKEN")) return respond("bad criteria", { status: 400 });
    const span = (day(to) - day(from)) / DAY_MS;
    if (span > 180) return respond(poPage.replace(PO_ROWS_START, PO_ROWS_START + "").replace("Total 1 result(s)", "Selected Date Range should be within 180 days."), { status: 200 });
    if (pageNo === 1) state.poWindows.push({ from, to, span });
    let matches = (opts.pos || []).filter((r) => opts.ignoreDateFilter || (day(r.date) >= day(from) && day(r.date) <= day(to)));
    const total = matches.length;
    matches = matches.slice((pageNo - 1) * perPage, pageNo * perPage);
    const pages = Math.max(1, Math.ceil(total / perPage));
    const links = pages > 1 ? Array.from({ length: pages }, (_, k) => `<a href="#" onclick="postRequest('/epsn/searchPO.do?rly=-1&dateFrom=${from}&dateTo=${to}&pageNo=${k + 1}&searchRange=2&poNo=&count=${total}&recordsPerPage=${perPage}');">${k + 1}</a>`).join("&nbsp;") : "";
    const head = poPage.slice(0, poPage.indexOf(PO_ROWS_START) + PO_ROWS_START.length).replace("Total 1 result(s)", `Total ${total} result(s)`);
    const tail = poPage.slice(poPage.indexOf(PO_ROWS_END));
    if (total === 0 && opts.emptyAsMessage) return respond(`<html><body><form name="searchPOForm" method="post" action="/epsn/searchPO.do"><input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="T"><input type="text" name="poNo"><input type="radio" name="searchRange" value="2"></form><span class="errorStyle">No Record Found</span></body></html>`);
    return respond(head + matches.map((r, i) => poRow(r, (pageNo - 1) * perPage + i + 1)).join("") + tail.replace("</body>", `<table><tr><td>${links}</td></tr></table></body>`));
  };

  /* ---- vendorInspectionCallList.do ---- */
  const icRow = (r) => `<tr><td>05/05/2026</td><td>TPI AGENCY</td><td><a href="#" onclick="viewPastCall('01','1');">${esc(r.poNo)}<br /> dt. 16/01/2026</a></td>
    <td class="dataText">${esc(r.callId)}</td><td class="dataText"><a href="#" onclick="viewPastCallpoSr('${r.poSerial}','01','1');">${esc(r.poSerial)}</a></td>
    <td class="dataText">ITEM</td><td class="dataText">Product</td><td class="dataText">1</td><td class="dataText">08/05/2026</td><td class="dataText">07/05/2026</td>
    <td class="dataText">${r.icDate || "08/05/2026"}</td><td class="dataText">09/05/2026</td><td class="dataText">1</td><td class="dataText">${r.status || "Completed (IC Issued)"}</td>
    <td class="dataText"><a href="#" onclick="viewCall('1','${r.callId}','01','1');"><img title="View Call Details"></a>${r.link ? `<a href="${r.link}" target="_blank" title="View/ Download IC PDF">p</a>` : ""}<a href="#" onclick="icRevaidate('9');">r</a></td></tr>`;

  const icSearch = (p) => {
    const poNo = p.get("poNo");
    const poSr = p.get("poSr");
    const pageNo = Number(p.get("pageNo") || 1);
    state.icSearches.push({ poNo, poSr, pageNo, dateFrom: p.get("dateFrom"), dateFromIC: p.get("dateFromIC"), token: p.get("org.apache.struts.taglib.html.TOKEN") });
    const pageSize = opts.icPageSize || 100;
    const from = p.get("dateFrom");
    let rows = (opts.icRows || []).filter((r) => (!poNo || r.poNo === poNo) && (!poSr || r.poSerial === poSr));
    if (opts.icWindowFrom) rows = rows.filter(() => day(from) <= day(opts.icWindowFrom));
    if (opts.icEcho) rows = rows.concat(opts.icEcho);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const pageRows = rows.slice((pageNo - 1) * pageSize, pageNo * pageSize);
    const links = Array.from({ length: pages }, (_, k) => `<td><a href="#" onClick="return navigate('${k + 1}')">${k + 1}</a></td>`).join("");
    const head = icPage.slice(0, icPage.indexOf(IC_ROWS_START) + IC_ROWS_START.length);
    const tail = icPage.slice(icPage.indexOf(IC_ROWS_END));
    state.tokens++;
    const token = `RTOKEN-${state.tokens}`;
    // Like the real page: the result table and the paging links live INSIDE inspectionCallForm.
    const full = (head + pageRows.map(icRow).join("") + tail).replace("</form>", "").replace("</body>", `<table><tr>${pages > 1 ? links : ""}</tr></table></form></body>`);
    return respond(full.replace(/FAKE-TOKEN-0123456789abcdef0123456789abcdef/g, token));
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const body = init.body ?? null;
    calls.push({ path: u.pathname, method, body });
    if (opts.networkDown && opts.networkDown(u.pathname, calls.length)) throw new TypeError("Failed to fetch");
    if (method === "GET") {
      state.pdfHits.set(u.pathname, (state.pdfHits.get(u.pathname) || 0) + 1);
      const behaviour = (opts.pdf && opts.pdf(u.pathname, state.pdfHits.get(u.pathname))) || "ok";
      if (behaviour === "ok") return respond(pdf(u.pathname), { contentType: "application/pdf" });
      if (behaviour === "404") return respond("not found", { status: 404 });
      if (behaviour === "500") return respond("boom", { status: 500 });
      if (behaviour === "html") return respond("<html><body><h1>Application error</h1><table></table></body></html>");
      if (behaviour === "login") return respond(loginPage);
      if (behaviour === "network") throw new TypeError("Failed to fetch");
    }
    if (opts.expiredFrom && calls.length >= opts.expiredFrom) return respond(loginPage);
    const params = new URLSearchParams(body || "");
    if (u.pathname === "/epsn/vndr/activity/ajax.do") {
      if (params.get("ajaxMode") !== "getMyActivitesData") return respond("{}", { status: 400 });
      if (typeof opts.notifications === "function") return opts.notifications(respond);
      return respond(JSON.stringify({ nl: opts.notifications || [] }), { contentType: "application/json" });
    }
    if (u.pathname === "/epsn/searchPO.do") {
      if (params.get("searchParam") === "showPage") {
        state.tokens++;
        return respond(searchPage.replace("FAKE-TOKEN-0123456789abcdef0123456789abcdef", `TOKEN-${state.tokens}`));
      }
      return poSearch(params);
    }
    if (u.pathname === "/epsn/tpi/vendorInspectionCallList.do") {
      if (!params.has("org.apache.struts.taglib.html.TOKEN")) {
        state.tokens++;
        return respond(listPage.replace("FAKE-TOKEN-0123456789abcdef0123456789abcdef", `TOKEN-${state.tokens}`));
      }
      return icSearch(params);
    }
    return respond("unexpected", { status: 404 });
  };
  return { fetchImpl, calls, state };
}

const note = (id, message, subject = "Inspection", ref = "9000000001") => ({ MESSAGE: message, NOTIFICATION_ID: String(id), NOTIFICATION_DT: "2026-10-15 10:24:49.0", MODULE_WA: "PT", SUBJECT: subject, NOTIFICATION_STATUS: "0", DATED: "15/10/2026", REF_ID: ref });
const icMsg = (po, sr) => `IC issued for PONo : ${po} , POSrNo : ${sr}`;

export async function runBatchTests({ test, assert, eq, rejects, fixture }) {
  const searchPage = await fixture("crn-search-page.html");
  const poPage = await fixture("po-results-page.html");
  const listPage = await fixture("ic-list-page.html");
  const icPage = await fixture("ic-results-page.html");
  const loginPage = await fixture("login-page.html");
  const pages = { searchPage, poPage, listPage, icPage, loginPage };
  const saved = () => {
    const files = [];
    return { files, saveFile: async (bytes, path) => (files.push({ path, bytes }), { downloadId: files.length, filename: path.split("/").pop(), path }) };
  };
  const ZERO = { retryDelayMs: 0, sleep: async () => {} };
  const mkPos = (n, date, { unit = "HQ/CR", prefix = "27253922", link = true } = {}) =>
    Array.from({ length: n }, (_, i) => {
      const poNo = `${prefix}${String(100000 + i).slice(1)}${date.slice(0, 2)}`;
      return { poNo, unit, date, link: link ? `/ireps/etender/pdfdocs/MMIS/PO/2026/${date.slice(3, 5)}/${unit.replace("/", "")}${poNo}.pdf` : null };
    });

  /* ------------------------------------------------------------ helpers */

  await test("batch utils: splitDateRange keeps every window within IREPS' 180-day limit and covers the range exactly", () => {
    eq(JSON.stringify(splitDateRange("01/10/2026", "01/10/2026")), JSON.stringify([{ dateFrom: "01/10/2026", dateTo: "01/10/2026" }]));
    const w = splitDateRange("01/01/2025", "31/12/2026");
    assert(w.length >= 4, `expected several windows, got ${w.length}`);
    eq(w[0].dateFrom, "01/01/2025");
    eq(w[w.length - 1].dateTo, "31/12/2026");
    for (let i = 0; i < w.length; i++) {
      assert((day(w[i].dateTo) - day(w[i].dateFrom)) / DAY_MS <= 180, `window ${i} spans more than 180 days`);
      if (i) eq(day(w[i].dateFrom) - day(w[i - 1].dateTo), DAY_MS, "windows are contiguous with no gap and no overlap");
    }
    eq(isoToIrepsDate("2026-10-05"), "05/10/2026");
    eq(isoToIrepsDate("2026-02-30"), null);
  });

  await test("batch utils: withRetry retries network errors / HTTP 5xx only, never an expired session", async () => {
    let n = 0;
    eq(await withRetry(async () => (++n < 3 ? Promise.reject(new IrepsError("X", "net", { reason: "network" })) : "ok"), ZERO), "ok");
    eq(n, 3);
    n = 0;
    await rejects(withRetry(async () => (++n, Promise.reject(new IrepsError("IREPS_SESSION_EXPIRED", "login", { reason: "network" }))), ZERO), "IREPS_SESSION_EXPIRED");
    eq(n, 1, "authentication errors are not retried");
    n = 0;
    await rejects(withRetry(async () => (++n, Promise.reject(new IrepsError("IREPS_PO_INVALID_PDF", "html"))), ZERO), "IREPS_PO_INVALID_PDF");
    eq(n, 1, "a non-PDF answer is not retried");
  });

  /* ============================================================== PO by date */

  await test("PO date: validation - invalid, reversed, and unreasonably wide ranges are rejected before any request", async () => {
    for (const [a, b] of [["", "01/01/2026"], ["31/02/2026", "01/03/2026"], ["02/01/2026", "01/01/2026"], ["01/01/2010", "01/01/2026"]]) {
      let threw = false;
      try {
        validatePoDateSelection(a, b);
      } catch (e) {
        threw = e instanceof IrepsError && e.code === "IREPS_INVALID_REQUEST";
      }
      assert(threw, `${a}..${b} should be rejected`);
    }
    const sim = simulator(pages, { pos: [] });
    await rejects(runPoDateDownload({ dateFrom: "02/01/2026", dateTo: "01/01/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults }), "IREPS_INVALID_REQUEST");
    eq(sim.calls.length, 0, "no request before validation passes");
    eq(validatePoDateSelection("01/10/2026", "01/10/2026").windows.length, 1, "a single date is a one-day range");
  });

  await test("PO date: a single date with several records - search request is searchCriteria=PO, searchRange=2, DD/MM/YYYY, fresh token; every PDF saved under the PO-date folder", async () => {
    const pos = [...mkPos(3, "05/10/2026"), ...mkPos(2, "06/10/2026", { prefix: "99999" })];
    const sim = simulator(pages, { pos });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.found, 3);
    eq(state.counts.downloaded, 3);
    eq(files.length, 3);
    const search = sim.calls.find((c) => c.path === "/epsn/searchPO.do" && !c.body.startsWith("searchParam"));
    const p = new URLSearchParams(search.body);
    eq(p.get("searchCriteria"), "PO");
    eq(p.get("searchRange"), "2");
    eq(p.get("dateFrom"), "05/10/2026");
    eq(p.get("dateTo"), "05/10/2026");
    assert(/^TOKEN-\d+$/.test(p.get("org.apache.struts.taglib.html.TOKEN")), "the token comes from the live page, not a constant");
    assert(files.every((f) => /^DocLink\/IREPS\/PO\/2026-10-05\/PO_\d+_2026-10-05\.pdf$/.test(f.path)), files.map((f) => f.path).join(","));
    eq(state.phase, "complete");
  });

  /** A Save to: ECM / S3 saver: records how each item is filed; item `failAt` goes local instead. */
  const ecmSaver = ({ failAt = 0 } = {}) => {
    const filed = [];
    return {
      filed,
      saveFile: async (bytes, path, item) => {
        filed.push({ path, ecm: item.ecm });
        const n = filed.length;
        if (n === failAt) return { filename: path.split("/").pop(), downloadId: n, ecm: { status: "failed", code: "ECM_UNAVAILABLE" } };
        return { filename: path.split("/").pop(), downloadId: null, ecm: { status: "stored", site: "hosur", uid: `u-${n}` } };
      }
    };
  };

  await test("PO date: under Save to ECM / S3 every PO is filed as poCopy with its PO number, and each item records where it went", async () => {
    const pos = mkPos(3, "05/10/2026");
    const sim = simulator(pages, { pos });
    const ecm = ecmSaver({ failAt: 2 });
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile: ecm.saveFile, concurrency: 1, ...ZERO });
    eq(state.counts.downloaded, 3);
    eq(ecm.filed.length, 3);
    assert(ecm.filed.every((f) => f.ecm.kind === "poCopy"), JSON.stringify(ecm.filed));
    eq(ecm.filed.map((f) => f.ecm.fields.customer_po_number).sort().join(","), pos.map((p) => p.poNo).sort().join(","));
    eq(state.items.map((i) => i.ecm && i.ecm.status).join(","), "stored,failed,stored");
  });

  await test("PO date: a local save (no ECM) leaves every item's ecm empty", async () => {
    const sim = simulator(pages, { pos: mkPos(2, "05/10/2026") });
    const { saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.downloaded, 2);
    assert(state.items.every((i) => i.ecm === null), JSON.stringify(state.items.map((i) => i.ecm)));
  });

  await test("PO date: a range with several PO dates downloads each into its own date folder", async () => {
    const sim = simulator(pages, { pos: [...mkPos(2, "03/10/2026"), ...mkPos(2, "04/10/2026", { prefix: "11111" }), ...mkPos(1, "20/10/2026", { prefix: "22222" })] });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "03/10/2026", dateTo: "10/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.downloaded, 4);
    eq(new Set(files.map((f) => f.path.split("/")[3])).size, 2);
    assert(files.some((f) => f.path.includes("/2026-10-03/")) && files.some((f) => f.path.includes("/2026-10-04/")));
  });

  await test("PO date: more than 20 matching records - every result page is followed, nothing silently dropped", async () => {
    const sim = simulator(pages, { pos: mkPos(47, "07/10/2026") });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "07/10/2026", dateTo: "07/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.found, 47, "all 47 records, not the first 20");
    eq(state.counts.downloaded, 47);
    eq(new Set(files.map((f) => f.path)).size, 47, "47 distinct files");
    eq(state.searches[0].pages, 3);
  });

  await test("PO date: no matching POs is a clear, successful 'nothing found' result (both an empty table and an IREPS 'No Record Found' message)", async () => {
    for (const emptyAsMessage of [false, true]) {
      const sim = simulator(pages, { pos: [], emptyAsMessage });
      const { files, saveFile } = saved();
      const state = await runPoDateDownload({ dateFrom: "07/10/2026", dateTo: "07/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
      eq(state.counts.found, 0, `emptyAsMessage=${emptyAsMessage}`);
      eq(files.length, 0);
      eq(state.phase, "complete");
    }
  });

  await test("PO date: rows outside the selected range are not downloaded even if IREPS returns them; true duplicates are counted once", async () => {
    const inRange = mkPos(2, "05/10/2026");
    const pos = [...inRange, inRange[0], ...mkPos(2, "09/10/2026", { prefix: "33333" })];
    const sim = simulator(pages, { pos, ignoreDateFilter: true });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.found, 2);
    eq(state.counts.outOfRange, 2);
    eq(state.counts.duplicates, 1);
    eq(files.length, 2);
  });

  await test("PO date: the same PO number from different units gets distinct, unit-qualified file names (no overwrite, no loss)", async () => {
    const pos = [
      { poNo: "27253922100240", unit: "HQ/CR", date: "05/10/2026", link: "/ireps/etender/pdfdocs/MMIS/PO/2026/10/a.pdf" },
      { poNo: "27253922100240", unit: "HQ/NR", date: "05/10/2026", link: "/ireps/etender/pdfdocs/MMIS/PO/2026/10/b.pdf" },
      { poNo: "27253922100241", unit: "HQ/CR", date: "05/10/2026", link: "/ireps/etender/pdfdocs/MMIS/PO/2026/10/c.pdf" }
    ];
    const sim = simulator(pages, { pos });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.downloaded, 3);
    const names = files.map((f) => f.path.split("/").pop());
    eq(new Set(names).size, 3, names.join(","));
    assert(names.includes("PO_27253922100240_HQ_CR_2026-10-05.pdf") && names.includes("PO_27253922100240_HQ_NR_2026-10-05.pdf"), names.join(","));
    assert(names.includes("PO_27253922100241_2026-10-05.pdf"), "a non-colliding PO keeps the plain name");
    // identical unit labels still never collide
    const same = assignPoDatePaths([
      { poNo: "1", railwayUnit: "U", dateKey: "2026-10-05" },
      { poNo: "1", railwayUnit: "U", dateKey: "2026-10-05" }
    ]);
    eq(new Set(same.values()).size, 2);
    eq(buildPoDateDownloadPath({ poNo: "A/B", dateKey: "2026-10-05" }), "DocLink/IREPS/PO/2026-10-05/PO_A_B_2026-10-05.pdf");
  });

  await test("PO date: a row with no PDF link is 'skipped' with a reason; a broken link fails without stopping the rest; nothing is saved for either", async () => {
    const pos = [...mkPos(3, "05/10/2026"), ...mkPos(1, "05/10/2026", { prefix: "55555", link: false })];
    const sim = simulator(pages, { pos, pdf: (path) => (path.includes(pos[1].poNo) ? "404" : "ok") });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(state.counts.found, 4);
    eq(state.counts.downloaded, 2);
    eq(state.counts.failed, 1);
    eq(state.counts.skipped, 1);
    const skipped = state.items.find((i) => i.status === PO_ITEM_STATUS.SKIPPED);
    assert(skipped.error && skipped.error.detail.includes("link"), "reason is stated");
    eq(files.length, 2, "failed and skipped rows leave no file");
  });

  await test("PO date: an HTML page or login page answering a PDF link is never saved as a .pdf", async () => {
    const pos = mkPos(3, "05/10/2026");
    const sim = simulator(pages, { pos, pdf: (path) => (path.includes(pos[1].poNo) ? "html" : path.includes(pos[2].poNo) ? "login" : "ok") });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, concurrency: 1, ...ZERO });
    eq(files.length, 1);
    const codes = state.items.filter((i) => i.status === "failed").map((i) => i.error.code).sort();
    assert(codes.includes("IREPS_PO_INVALID_PDF") && codes.includes("IREPS_SESSION_EXPIRED"), codes.join(","));
    eq(state.sessionExpired, true);
  });

  await test("PO date: an expired session at search time stops with IREPS_SESSION_EXPIRED and downloads nothing", async () => {
    const sim = simulator(pages, { pos: mkPos(2, "05/10/2026"), expiredFrom: 1 });
    const { files, saveFile } = saved();
    await rejects(runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO }), "IREPS_SESSION_EXPIRED");
    eq(files.length, 0);
    eq(sim.calls.length, 1, "no retry loop on an authentication error");
  });

  await test("PO date: failed downloads are retried without re-downloading the successful ones", async () => {
    const pos = mkPos(4, "05/10/2026");
    let failFirst = true;
    const sim = simulator(pages, { pos, pdf: (path) => (path.includes(pos[2].poNo) && failFirst ? "404" : "ok") });
    const { files, saveFile } = saved();
    const deps = { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO };
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, deps);
    eq(state.counts.downloaded, 3);
    eq(state.counts.failed, 1);
    const hitsBefore = new Map(sim.state.pdfHits);
    failFirst = false;
    await retryPoDateFailures(state, deps);
    eq(state.counts.downloaded, 4);
    eq(state.counts.failed, 0);
    eq(files.length, 4);
    for (const [path, n] of hitsBefore) if (!path.includes(pos[2].poNo)) eq(sim.state.pdfHits.get(path), n, `${path} was not fetched again`);
    eq(sim.calls.filter((c) => c.path === "/epsn/searchPO.do").length, 2, "retry did not search again (showPage + one search only)");
  });

  await test("PO date: transient HTTP 500 / network drop is retried automatically and succeeds; a 404 is not retried", async () => {
    const pos = mkPos(2, "05/10/2026");
    const sim = simulator(pages, { pos, pdf: (path, hit) => (path.includes(pos[0].poNo) ? (hit < 3 ? (hit === 1 ? "500" : "network") : "ok") : "404") });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "05/10/2026", dateTo: "05/10/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    eq(files.length, 1);
    eq(sim.state.pdfHits.get(pos[0].link), 3, "two transient failures then success");
    eq(sim.state.pdfHits.get(pos[1].link), 1, "404 is final");
    eq(state.counts.failed, 1);
  });

  await test("PO date: a range longer than the portal's 180 days is split into valid windows, merged, and de-duplicated across the boundary", async () => {
    const pos = [...mkPos(2, "10/01/2026"), ...mkPos(2, "10/05/2026", { prefix: "44444" }), ...mkPos(2, "10/09/2026", { prefix: "66666" })];
    const sim = simulator(pages, { pos });
    const { files, saveFile } = saved();
    const state = await runPoDateDownload({ dateFrom: "01/01/2026", dateTo: "30/09/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, saveFile, ...ZERO });
    assert(state.counts.windows >= 2, `windows: ${state.counts.windows}`);
    eq(sim.state.poWindows.length, state.counts.windows);
    assert(sim.state.poWindows.every((w) => w.span <= 180), "every request stays within 180 days");
    eq(state.counts.found, 6);
    eq(files.length, 6);
  });

  await test("PO date: searches are strictly sequential - the Struts token of one window is never shared with another", async () => {
    const sim = simulator(pages, { pos: mkPos(2, "10/01/2026") });
    await searchPosByDate({ dateFrom: "01/01/2026", dateTo: "30/09/2026" }, { fetch: sim.fetchImpl, parseHtml: parsePoSearchResults, ...ZERO });
    const tokens = sim.calls.filter((c) => c.path === "/epsn/searchPO.do" && !c.body.startsWith("searchParam") && c.body.includes("TOKEN")).map((c) => new URLSearchParams(c.body).get("org.apache.struts.taglib.html.TOKEN"));
    eq(new Set(tokens).size, tokens.length, "each search used its own freshly loaded token");
  });

  /* ================================================== notifications -> IC */

  await test("notifications: parser keeps exact identifiers (leading zeros), tolerates spacing/case/punctuation, ignores everything but IC-issued", () => {
    const real = note(6491236, "IC issued for PONo : L3251421101345 , POSrNo : 001");
    const p = parseIcNotification(real);
    eq(p.poNo, "L3251421101345");
    eq(p.poSerial, "001", "leading zeros preserved");
    eq(p.notificationId, "6491236");
    for (const msg of ["ic issued for pono: ABC-12/3 ;posrno:007", "IC  Issued for PONo:ABC-12/3, POSrNo : 007 ", "IC Issued for PO No : ABC-12/3 , PO Sr No : 007."]) {
      const q = parseIcNotification(note(1, msg));
      eq(q.poNo, "ABC-12/3", msg);
      eq(q.poSerial, "007", msg);
    }
    const sel = selectIcNotifications([
      note(1, "LOA issued by STORES/NORTH EASTERN RLY in f/o M/s X against T. No. 24261631", "Letter of Acceptance"),
      real,
      note(3, "Negotiation scheduled for tender 12", "Negotiation"),
      note(4, "IC issued for PONo : ZZ , POSrNo : 002", "Letter of Acceptance"),
      null,
      {}
    ]);
    eq(sel.inspected, 6);
    eq(sel.icNotifications.length, 1, "only the Inspection / IC issued notice");
    eq(isIcIssuedNotification(note(9, "IC issued for PONo : 1 , POSrNo : 1", "Inspection")), true);
  });

  await test("notifications: missing/malformed PO details are reported as unreadable, never guessed", () => {
    for (const msg of ["IC issued for PONo : , POSrNo : 001", "IC issued for PONo : ABC123", "IC issued", "IC issued for POSrNo : 004"]) {
      const p = parseIcNotification(note(1, msg));
      assert(!(p.poNo && p.poSerial), `${msg} -> ${JSON.stringify([p.poNo, p.poSerial])}`);
    }
    eq(parseIcNotification(note(1, "IC issued for POSrNo : 004")).poNo, null);
  });

  await test("notifications: response handling - empty nl, missing nl, malformed JSON, login page", () => {
    eq(parseNotificationResponse(JSON.stringify({ nl: [] })).length, 0);
    eq(parseNotificationResponse(JSON.stringify({ UNREAD_MSG_CNT: "3" })).length, 0);
    try {
      parseNotificationResponse("{not json");
      throw new Error("should throw");
    } catch (e) {
      eq(e.code, "IREPS_NOTIFICATIONS_INVALID");
    }
    try {
      parseNotificationResponse(loginPage);
      throw new Error("should throw");
    } catch (e) {
      eq(e.code, "IREPS_SESSION_EXPIRED");
    }
  });

  await test("IC parser (live layout): result table inside the form + one data cell more than headers - status, quantities and links stay on the right columns, grouped rows included", () => {
    const head = ["Call Date", "TPI Agency", "PO No. / Date", "Call Id", "PO Sr.", "PL No: Description", "Type", "Offer Qty.", "Registration Date", "Inspection Start Date", "IC Date", "Passed Qty.", "Call Status", "Actions"];
    const tail = (call, status, link) => `<td>${call}</td><td><a href="#" onclick="x()">00${call.slice(-1)}</a></td><td>DESC</td><td>Product</td><td>36</td><td>15/10/2026</td><td>09/10/2026</td><td>14/10/2026</td><td>15/10/2026</td><td>36</td><td>${status}</td><td><a href="#"><img title="View Call Details"></a>${link ? `<a href="${link}" title="View/ Download IC PDF">p</a>` : ""}</td>`;
    const html = `<html><body><form name="inspectionCallForm" action="/epsn/tpi/vendorInspectionCallList.do"><input type="hidden" name="org.apache.struts.taglib.html.TOKEN" value="T">
      <table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>
      <tr><td rowspan="2">07/10/2026</td><td rowspan="2">AGENCY</td><td rowspan="2"><a href="#">P9<br /> dt. 24/12/2025</a></td>${tail("C1", "Completed (IC Issued)", "/ic/1.pdf")}</tr>
      <tr>${tail("C2", "Completed (IC Issued)", "/ic/2.pdf")}</tr>
      <tr><td>08/10/2026</td><td>AGENCY</td><td><a href="#">P8<br /> dt. 01/01/2026</a></td>${tail("C3", "Call Registered", null)}</tr></table></form></body></html>`;
    const r = parseIcSearchResults(html, null);
    eq(r.recordCount, 3, "table inside <form> is not discarded");
    eq(r.records.map((x) => x.callStatus).join("|"), "Completed (IC Issued)|Completed (IC Issued)|Call Registered");
    eq(r.records.map((x) => x.passedQty).join("|"), "36|36|36");
    eq(r.records.map((x) => x.poNo).join("|"), "P9|P9|P8", "grouped PO number carried to the second row");
    eq(r.records[1].icDate, "14/10/2026");
    assert(r.records[0].icPdfUrl.endsWith("/ic/1.pdf") && r.records[1].icPdfUrl.endsWith("/ic/2.pdf") && r.records[2].icPdfUrl === null);
  });

  const ic = (poNo, poSerial, callId, link = true, extra = {}) => ({ poNo, poSerial, callId, link: link ? `/ireps/etender/ct/tpi/ic/102026/${callId}.pdf` : null, ...extra });
  const runIc = (sim, extra = {}) => {
    const s = saved();
    return runIcNotificationDownload({ fetch: sim.fetchImpl, saveFile: s.saveFile, ...ZERO, ...extra }).then((state) => ({ state, files: s.files }));
  };

  await test("IC notifications: one IC-issued notification - request flow, matched row, file name, manifest (HAR-shaped data, invented values)", async () => {
    const sim = simulator(pages, { notifications: [note(101, icMsg("L1000000000001", "001"), "Inspection", "8000000001")], icRows: [ic("L1000000000001", "001", "8000000001")] });
    const { state, files } = await runIc(sim);
    eq(state.counts.inspected, 1);
    eq(state.counts.icNotifications, 1);
    eq(state.counts.downloaded, 1);
    eq(files[0].path, "DocLink/IREPS/IC/L1000000000001/IC_L1000000000001_001_8000000001.pdf");
    const s = sim.state.icSearches[0];
    eq(s.poNo, "L1000000000001");
    eq(s.poSr, "001");
    const first = sim.calls.find((c) => c.path === "/epsn/vndr/activity/ajax.do");
    eq(first.body, "ajaxMode=getMyActivitesData");
    const manifest = state.manifest;
    eq(manifest.length, 1);
    eq(manifest[0].refIdMatchesCallId, true);
    eq(manifest[0].outcome, "completed");
    assert(!JSON.stringify(manifest).toLowerCase().includes("token") && !JSON.stringify(manifest).toLowerCase().includes("cookie"), "manifest holds no secrets");
  });

  await test("IC notifications: under Save to ECM / S3 each IC is filed as inspectionCertificate (IC number from the PDF name, PO, IC date); the manifest records the ECM outcome", async () => {
    const sim = simulator(pages, { notifications: [note(101, icMsg("L1000000000001", "001"), "Inspection", "8000000001")], icRows: [ic("L1000000000001", "001", "8000000001", true, { icDate: "12/10/2026" })] });
    const ecm = ecmSaver();
    const { state } = await runIc(sim, { saveFile: ecm.saveFile });
    eq(state.counts.downloaded, 1);
    eq(ecm.filed.length, 1);
    const filed = ecm.filed[0].ecm;
    eq(filed.kind, "inspectionCertificate");
    eq(filed.fields.ic_number, "8000000001");
    eq(filed.fields.customer_po_number, "L1000000000001");
    eq(filed.fields.ic_date, "12/10/2026");
    eq(state.items[0].ecm.status, "stored");
    eq(state.manifest[0].ecm.status, "stored");
    eq(state.manifest[0].ecm.uid, "u-1");
  });

  await test("IC notifications: several notifications with different POs are all processed in one run, with a fresh token per search", async () => {
    const rows = [ic("P1", "001", "C1"), ic("P2", "002", "C2"), ic("P3", "010", "C3")];
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"), "Inspection", "C1"), note(2, icMsg("P2", "002"), "Inspection", "C2"), note(3, icMsg("P3", "010"), "Inspection", "C3")], icRows: rows });
    const { state, files } = await runIc(sim);
    eq(state.counts.downloaded, 3);
    eq(files.length, 3);
    eq(new Set(sim.state.icSearches.map((s) => s.token)).size, 3, "no search reused another's token");
  });

  await test("IC notifications: two notifications for the same PO (different serials) each download their own IC; same PO + serial is searched once", async () => {
    const rows = [ic("P1", "001", "C1"), ic("P1", "002", "C2")];
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"), "Inspection", "C1"), note(2, icMsg("P1", "002"), "Inspection", "C2"), note(3, icMsg("P1", "001"), "Inspection", "C1")], icRows: rows });
    const { state, files } = await runIc(sim);
    eq(files.length, 2);
    eq(sim.state.icSearches.length, 2, "(P1,001) searched once for two notifications");
    eq(state.counts.duplicates, 1, "the third notification resolves to an already queued PDF");
    const dup = buildIcManifest(state).filter((m) => m.outcome === "duplicate_skipped");
    eq(dup.length, 1);
  });

  await test("IC notifications: PO serial leading zeros are sent and matched exactly ('001' never matches '1' or '01')", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"))], icRows: [ic("P1", "1", "WRONG1"), ic("P1", "01", "WRONG2"), ic("P1", "001", "RIGHT")] });
    const { state, files } = await runIc(sim);
    // the simulator filters server-side by exact poSr; also verify the client-side guard on a sloppy server
    eq(files.length, 1);
    eq(files[0].path.split("/").pop(), "IC_P1_001_RIGHT.pdf");
    eq(sim.state.icSearches[0].poSr, "001");
    const sloppy = matchIcRows([{ poNo: "P1", poSerial: "1", callStatus: "Completed (IC Issued)" }, { poNo: "P1", poSerial: "001", callStatus: "Completed (IC Issued)" }, { poNo: "P2", poSerial: "001", callStatus: "Completed (IC Issued)" }, { poNo: "P1", poSerial: "001", callStatus: "Call Registered" }], { poNo: "P1", poSerial: "001" });
    eq(sloppy.length, 1, "exact PO + exact serial + IC-issued status only");
  });

  await test("IC notifications: no IC-issued notification (and an unrelated LOA) -> nothing downloaded, no inspection search made", async () => {
    const sim = simulator(pages, { notifications: [note(1, "LOA issued by STORES/NORTH EASTERN RLY in f/o M/s X against T. No. 24261631", "Letter of Acceptance")], icRows: [ic("P1", "001", "C1")] });
    const { state, files } = await runIc(sim);
    eq(state.counts.inspected, 1);
    eq(state.counts.icNotifications, 0);
    eq(files.length, 0);
    eq(sim.calls.filter((c) => c.path.includes("vendorInspectionCallList")).length, 0);
    const empty = await runIc(simulator(pages, { notifications: [] }));
    eq(empty.state.counts.inspected, 0);
    eq(empty.state.phase, "complete");
  });

  await test("IC notifications: an IC-issued notice with unreadable PO details is reported as unprocessed while the others still download", async () => {
    const sim = simulator(pages, { notifications: [note(1, "IC issued for PONo : , POSrNo : 001"), note(2, icMsg("P2", "002"), "Inspection", "C2")], icRows: [ic("P2", "002", "C2")] });
    const { state, files } = await runIc(sim);
    eq(files.length, 1);
    eq(state.counts.unparsed, 1);
    eq(state.notifications[0].outcome, NOTIFICATION_OUTCOME.UNPARSED);
    eq(sim.state.icSearches.length, 1, "no search for the unreadable notice");
  });

  await test("IC notifications: no matching inspection-call record is reported with PO and serial; a matching row without an IC link is skipped, not invented", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("PX", "001")), note(2, icMsg("P2", "002"), "Inspection", "C2")], icRows: [ic("P2", "002", "C2", false)] });
    const { state, files } = await runIc(sim);
    eq(files.length, 0);
    eq(state.notifications[0].outcome, NOTIFICATION_OUTCOME.NOT_FOUND);
    assert(state.notifications[0].note.includes("PX") && state.notifications[0].note.includes("001"));
    eq(state.notifications[1].outcome, NOTIFICATION_OUTCOME.NO_LINK);
    eq(state.counts.skipped, 1);
    eq(state.items[0].url, null);
  });

  await test("IC notifications: when the default window finds nothing the search is widened once before 'not found'", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"), "Inspection", "C1")], icRows: [ic("P1", "001", "C1")], icWindowFrom: "01/01/2020" });
    const { state, files } = await runIc(sim);
    eq(files.length, 1);
    eq(sim.state.icSearches.length, 2, "default window, then widened");
    assert(sim.state.icSearches[1].dateFrom !== sim.state.icSearches[0].dateFrom, "the second search uses an earlier From date");
    eq(state.counts.downloaded, 1);
  });

  await test("IC notifications: several matching rows -> every distinct IC PDF is downloaded (no arbitrary first row)", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"), "Inspection", "C2")], icRows: [ic("P1", "001", "C1"), ic("P1", "001", "C2"), ic("P1", "001", "C3")] });
    const { state, files } = await runIc(sim);
    eq(files.length, 3);
    eq(state.items.filter((i) => i.refIdMatchesCallId).length, 1, "REF_ID only marks the row it equals");
  });

  await test("IC notifications: a REF_ID that matches no Call Id does not block the download and is reported as unverified", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"), "Inspection", "NOT-A-CALL")], icRows: [ic("P1", "001", "C1")] });
    const { state, files } = await runIc(sim);
    eq(files.length, 1);
    eq(state.items[0].refIdMatchesCallId, false);
    eq(buildIcManifest(state)[0].refIdMatchesCallId, false);
  });

  await test("IC notifications: the same PDF reached from two notifications is downloaded once", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001")), note(2, icMsg("P1", "001"))], icRows: [ic("P1", "001", "C1")] });
    const { state, files } = await runIc(sim);
    eq(files.length, 1);
    eq(sim.state.pdfHits.get("/ireps/etender/ct/tpi/ic/102026/C1.pdf"), 1);
    eq(state.counts.duplicates, 1);
  });

  await test("IC notifications: result pages (navigate links) are all followed, each page using the token printed on the previous one", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ic("P1", "001", `C${i + 1}`));
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001"))], icRows: rows, icPageSize: 2 });
    const { state, files } = await runIc(sim);
    eq(files.length, 5);
    eq(sim.state.icSearches.map((s) => s.pageNo).join(","), "1,2,3");
    assert(sim.state.icSearches[1].token.startsWith("RTOKEN-") && sim.state.icSearches[1].token !== sim.state.icSearches[0].token, "page 2 carries the page-1 response's token");
    eq(state.notifications[0].pages, 3);
  });

  await test("IC notifications: an expired session stops everything with a clear state, nothing is saved, and the rest are not hammered", async () => {
    const sim = simulator(pages, { notifications: [note(1, icMsg("P1", "001")), note(2, icMsg("P2", "002"))], icRows: [ic("P1", "001", "C1"), ic("P2", "002", "C2")], expiredFrom: 2 });
    const { state, files } = await runIc(sim);
    eq(files.length, 0);
    eq(state.sessionExpired, true);
    assert(state.notifications.every((n) => n.outcome === NOTIFICATION_OUTCOME.SESSION_EXPIRED));
    eq(sim.calls.length, 2, "notifications + one rejected list page, then stop");
    const dead = simulator(pages, { notifications: (respond) => respond(loginPage) });
    await rejects(runIcNotificationDownload({ fetch: dead.fetchImpl, ...ZERO }), "IREPS_SESSION_EXPIRED");
  });

  await test("IC notifications: invalid JSON from the notification endpoint fails with a clear error", async () => {
    const sim = simulator(pages, { notifications: (respond) => respond("<<<garbage", { contentType: "application/json" }) });
    await rejects(runIcNotificationDownload({ fetch: sim.fetchImpl, ...ZERO }), "IREPS_NOTIFICATIONS_INVALID");
  });

  await test("IC notifications: non-PDF content (HTML error page) is rejected; partial failure keeps the good PDFs; retry fetches only the failed one", async () => {
    let bad = true;
    const rows = [ic("P1", "001", "C1"), ic("P2", "002", "C2"), ic("P3", "003", "C3")];
    const sim = simulator(pages, {
      notifications: [note(1, icMsg("P1", "001")), note(2, icMsg("P2", "002")), note(3, icMsg("P3", "003"))],
      icRows: rows,
      pdf: (path) => (path.endsWith("/C2.pdf") && bad ? "html" : "ok")
    });
    const s = saved();
    const deps = { fetch: sim.fetchImpl, saveFile: s.saveFile, ...ZERO };
    const state = await runIcNotificationDownload(deps);
    eq(state.counts.downloaded, 2);
    eq(state.counts.failed, 1);
    eq(state.items.find((i) => i.status === "failed").error.code, "IREPS_IC_INVALID_PDF");
    eq(s.files.length, 2, "nothing saved for the bad response");
    const before = new Map(sim.state.pdfHits);
    const searchesBefore = sim.state.icSearches.length;
    bad = false;
    await retryIcNotificationFailures(state, deps);
    eq(state.counts.downloaded, 3);
    eq(state.counts.failed, 0);
    eq(s.files.length, 3);
    eq(sim.state.pdfHits.get(rows[0].link), before.get(rows[0].link), "completed IC not fetched again");
    eq(sim.state.icSearches.length, searchesBefore, "retry did not search again for notifications that had worked");
  });

  await test("IC notifications: a search that failed transiently is retried inside the run; a persistent failure is reported per notification and the rest continue", async () => {
    let listLoads = 0;
    const sim = simulator(pages, {
      notifications: [note(1, icMsg("P1", "001")), note(2, icMsg("P2", "002"))],
      icRows: [ic("P1", "001", "C1"), ic("P2", "002", "C2")],
      networkDown: (path) => {
        if (path.includes("vendorInspectionCallList")) listLoads++;
        return listLoads === 1; // very first list-page request drops once
      }
    });
    const { state, files } = await runIc(sim);
    eq(files.length, 2, "transient failure absorbed by the retry");
    eq(state.counts.searchErrors, 0);
    // P1's search fails on every attempt (network drop x3); P2 is unaffected.
    let hits = 0;
    const flaky = simulator(pages, {
      notifications: [note(1, icMsg("P1", "001")), note(2, icMsg("P2", "002"))],
      icRows: [ic("P1", "001", "C1"), ic("P2", "002", "C2")],
      networkDown: (path) => path.includes("vendorInspectionCallList") && ++hits <= 3
    });
    const r = await runIc(flaky);
    eq(r.state.notifications[0].outcome, NOTIFICATION_OUTCOME.ERROR);
    eq(r.state.notifications[1].outcome, NOTIFICATION_OUTCOME.MATCHED);
    eq(r.files.length, 1);
  });
}
