/**
 * IREPS Inspection Certificate (IC) search-result parser.
 *
 * Input : raw server-rendered HTML from POST
 *         /epsn/tpi/vendorInspectionCallList.do (activity=searchResult,
 *         status=I / Completed / IC Issued) - untrusted.
 * Output: one record per inspection call row, with the IC PDF link.
 *
 * Captured layout (real portal, PO No. search, one PO with 4 issued ICs):
 *
 *   <table class="lightGrayTbl table-hover">
 *     <tr><th>Call Date</th><th>TPI Agency</th><th>PO No. / Date</th><th>Call Id</th>
 *         <th>PO Sr.</th><th>PL No: Description</th><th>Type</th><th>Offer Qty.</th>
 *         <th>Registration Date</th><th>Inspection Start Date</th><th>IC Date</th>
 *         <th>Passed Qty.</th><th>Call Status</th><th>Actions</th></tr>
 *     <tr>
 *       <td rowspan="4">05/05/2026</td>                          <!-- Call Date -->
 *       <td rowspan="4">TUV INDIA PVT LTD.-MUMBAI</td>           <!-- TPI Agency -->
 *       <td rowspan="4"><a href="#" onclick="viewPastCall(...)">27253922100240<br /> dt. 16/01/2026</a></td>
 *       <td>6038184070</td>  <!-- Call Id -->
 *       <td><a href="#" onclick="...">001</a></td>  <!-- PO Sr. -->
 *       <td>29160030: KIT FOR UNLOADER EXHAUST VALVE ...</td>
 *       <td>Product - Final Product Inspection</td>
 *       <td>106</td> <td>08/05/2026</td> <td>07/05/2026</td> <td>07/05/2026</td> <td>106</td>
 *       <td>Completed (IC Issued)</td>
 *       <td>
 *         <a href="#" onclick="viewCall(...)" title=""><img title="View Call Details"></a>
 *         <a href="/ireps/etender/ct/tpi/ic/052026/3480517.pdf" target="_blank" title="View/ Download IC PDF">...</a>
 *         <a href="#" onclick="icRevaidate('3480517');">...</a>
 *       </td>
 *     </tr>
 *     <tr> <!-- rows 2-4: same PO, no rowspan cells - only Call Id .. Actions --> </tr>
 *
 * IREPS groups every row of the same call date / PO under one <tr rowspan="N">
 * for the first three columns (Call Date, TPI Agency, PO No. / Date); the
 * DOM therefore does NOT repeat those cells on the following rows. This
 * parser tracks the "current group" values and applies them to every row
 * that is missing its own leading cells, so every IC of a multi-IC PO is
 * still fully described (never only the first).
 *
 * The IC document is identified by the anchor title "View/ Download IC PDF"
 * - never "View Call Details" (read-only info) and never "Revalidate IC"
 * (DocLink's downloader stays strictly read-only and never calls it).
 * Requires a DOMParser (offscreen document / tests).
 */

import { stripDangerousNodes } from "../../utils/sanitizer.js";
import { normalizeIrepsValue } from "../bill-parser.js";
import { normaliseText } from "../../utils/sanitizer.js";
import { resolveIcUrl } from "./ic-api.js";
import { normaliseHeaderLabel, cellText, anchorsOf, isMarkupHeaderRow, locateResultTable, resultEnvelope } from "../search-po/search-po-table.js";
import { comparablePoNo } from "../po/po-parser.js";

export const IC_LINK_TITLE = "view/ download ic pdf";

/** The three leading columns IREPS groups with rowspan (in header order). */
const GROUPED_KEYS = ["callDate", "tpiAgency", "poNoDate"];

/** Header label (normalised) -> record key. */
export const IC_HEADER_MAP = Object.freeze({
  calldate: "callDate",
  tpiagency: "tpiAgency",
  ponodate: "poNoDate",
  callid: "callId",
  posr: "poSerial",
  plnodescription: "plDescription",
  type: "inspectionType",
  offerqty: "offerQty",
  registrationdate: "registrationDate",
  inspectionstartdate: "inspectionStartDate",
  icdate: "icDate",
  passedqty: "passedQty",
  callstatus: "callStatus",
  action: "_action",
  actions: "_action"
});

/** @returns {string|null} record key for a header label, null when unknown. */
export function matchIcHeader(label) {
  const key = normaliseHeaderLabel(label);
  return Object.prototype.hasOwnProperty.call(IC_HEADER_MAP, key) ? IC_HEADER_MAP[key] : null;
}

/**
 * The IC number: IREPS names each IC PDF after it, e.g. ".../ct/tpi/ic/052026/3480517.pdf"
 * -> "3480517" (the same number the row's revalidate link carries). The table has no
 * IC-number column, and the Call Id is a different number.
 */
export function icNumberFromUrl(url) {
  if (!url) return null;
  let path;
  try {
    path = new URL(url, "https://ireps.invalid/").pathname;
  } catch {
    return null;
  }
  const m = /\/([A-Za-z0-9_-]+)\.pdf$/i.exec(path);
  return m ? m[1] : null;
}

/** Typed fields of an IC record (excluding the compound poNoDate, split below). */
export const IC_FIELDS = [
  "callDate",
  "tpiAgency",
  "poNo",
  "poDate",
  "callId",
  "poSerial",
  "plDescription",
  "inspectionType",
  "offerQty",
  "registrationDate",
  "inspectionStartDate",
  "icDate",
  "passedQty",
  "callStatus"
];

function createEmptyIcRecord() {
  const record = { index: 0, id: "" };
  for (const key of IC_FIELDS) record[key] = null;
  record.icPdfUrl = null;
  record.icNumber = null;
  record.links = [];
  record.rawColumns = {};
  return record;
}

/** "27253922100240\ndt. 16/01/2026" -> { poNo, poDate }. */
function splitPoNoDate(text) {
  const value = normalizeIrepsValue(text);
  if (!value) return { poNo: null, poDate: null };
  const lines = normaliseText(value).split("\n");
  const poNo = normalizeIrepsValue(lines[0]);
  const dateMatch = /dt\.?\s*(.+)$/i.exec(lines[1] || "");
  const poDate = dateMatch ? normalizeIrepsValue(dateMatch[1]) : normalizeIrepsValue(lines[1]);
  return { poNo, poDate };
}

/** A style that hides an element (display: none, visibility: hidden or collapse), in any spelling. */
const HIDING_STYLE = /(?:^|[;\s])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i;
/** Classes that hide an element in the usual stylesheets (Bootstrap, jQuery UI): each entry is a set of classes. */
const HIDING_CLASSES = Object.freeze([["hidden"], ["hide"], ["d-none"], ["invisible"], ["ui-helper-hidden"]]);

/**
 * The class sets the page's own <style> rules hide, e.g. ".hideCol { display: none }" -> [["hidecol"]]
 * and "td.a.b { visibility: hidden }" -> [["a", "b"]]. Rules inside @media (print) are left out. Read
 * before stripDangerousNodes() drops the <style> elements.
 * @param {Document} doc
 * @returns {string[][]}
 */
export function pageHidingClasses(doc) {
  const sets = [];
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const css = String(style.textContent || "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, "");
    for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!HIDING_STYLE.test(body)) continue;
      for (const selector of selectors.split(",")) {
        const simple = /^\s*(?:td|th)?((?:\.[\w-]+)+)\s*$/i.exec(selector);
        if (simple) sets.push(simple[1].slice(1).split(".").map((c) => c.toLowerCase()));
      }
    }
  }
  return sets;
}

/**
 * Whether IREPS hides this cell from the user, however it does it: an inline style, the hidden
 * attribute, a usual hiding class, or a class the page's own <style> hides (9.2).
 * @param {Element} cell
 * @param {string[][]} [hidingClasses]  pageHidingClasses() of the page
 * @returns {boolean}
 */
export function isHiddenCell(cell, hidingClasses = []) {
  if (cell.hasAttribute("hidden")) return true;
  if (HIDING_STYLE.test(cell.getAttribute("style") || "")) return true;
  const classes = new Set(String(cell.getAttribute("class") || "").toLowerCase().split(/\s+/).filter(Boolean));
  if (classes.size === 0) return false;
  return [...HIDING_CLASSES, ...hidingClasses].some((set) => set.every((c) => classes.has(c)));
}

/**
 * A row's cells as the user sees them: a cell IREPS hides is not a column.
 * @param {Element} row
 * @param {string[][]} [hidingClasses]  pageHidingClasses() of the page
 */
export function visibleCells(row, hidingClasses = []) {
  return Array.from(row.cells).filter((cell) => !isHiddenCell(cell, hidingClasses));
}

/**
 * Parse one IC row, applying the carried rowspan-group values (Call Date,
 * TPI Agency, PO No. / Date) when the row itself does not carry them.
 *
 * @param {Element} row
 * @param {{ labels: string[], keys: (string|null)[], extra?: number }} header
 * @param {object} group  mutable { values: Record<string,string|null> } carried across rows
 * @param {number} ordinal
 * @param {{ baseUrl?: string, hidingClasses?: string[][] }} [options]
 * @returns {{ record: object, warnings: string[] }}
 */
export function parseIcRow(row, header, group, ordinal = 1, options = {}) {
  const record = createEmptyIcRecord();
  record.index = ordinal;
  const warnings = [];
  const cells = visibleCells(row, options.hidingClasses);
  // The live page prints one more data cell than it has headers: a hidden copy of the IC Date
  // right after Offer Qty. (HAR entry 683, display: none), which visibleCells() leaves out however
  // IREPS hides it. Should a surplus cell still remain (hidden by a stylesheet DocLink cannot see),
  // parseIcSearchResults() measures it once per table as header.extra: the cells after Offer Qty.
  // are then aligned from the right, and the surplus cell(s) right after Offer Qty., where IREPS
  // puts its hidden one, are left unmapped. Aligned after IC Date instead, the Inspection Start
  // Date was read as the IC Date (9.2).
  const extra = Math.max(Number(header.extra) || 0, 0);
  const fullWidth = header.keys.length + extra;
  const missing = fullWidth - cells.length; // leading grouped columns this row does not repeat
  const lead = Math.max(missing, 0);

  if (missing > 0) {
    for (const key of GROUPED_KEYS.slice(0, missing)) {
      if (key === "poNoDate") {
        record.poNo = group.values.poNo ?? null;
        record.poDate = group.values.poDate ?? null;
      } else {
        record[key] = group.values[key] ?? null;
      }
    }
  }

  const surplusAfter = header.keys.indexOf("offerQty");
  const tailLength = surplusAfter === -1 ? 0 : header.keys.length - (surplusAfter + 1);
  const tailStart = surplusAfter === -1 ? Infinity : surplusAfter + 1 - lead; // first cell after Offer Qty.
  const headerIndexFor = (i) => {
    if (extra > 0 && i >= tailStart) {
      const fromRight = cells.length - 1 - i; // 0 = last cell
      return fromRight < tailLength ? header.keys.length - 1 - fromRight : -1; // -1: surplus cell
    }
    return lead + i;
  };

  cells.forEach((cell, i) => {
    const hi = headerIndexFor(i);
    const key = hi >= 0 && header.keys[hi] !== undefined ? header.keys[hi] : null;
    const label = hi >= 0 && header.labels[hi] !== undefined ? header.labels[hi] : `Column ${i + 1}`;
    const text = cellText(cell);
    for (const a of anchorsOf(cell)) {
      record.links.push({ text: a.text, title: a.title, href: a.href, url: resolveIcUrl(a.href, options.baseUrl), column: label, key });
    }
    if (key === "_action") return;
    if (key === "poNoDate") {
      const { poNo, poDate } = splitPoNoDate(text);
      record.poNo = poNo;
      record.poDate = poDate;
      record.rawColumns[label || "#"] = normalizeIrepsValue(text);
      return;
    }
    const value = normalizeIrepsValue(text);
    record.rawColumns[label || "#"] = value;
    if (key) record[key] = value;
  });

  // Refresh the carried group values whenever this row supplied them itself.
  if (missing === 0) {
    group.values.callDate = record.callDate;
    group.values.tpiAgency = record.tpiAgency;
    group.values.poNo = record.poNo;
    group.values.poDate = record.poDate;
  }

  const icAnchor = record.links.find((l) => l.title.toLowerCase() === IC_LINK_TITLE);
  record.icPdfUrl = icAnchor ? icAnchor.url : null;
  record.icNumber = icNumberFromUrl(record.icPdfUrl);
  if (!record.icPdfUrl) warnings.push(`IC row ${ordinal} (Call Id ${record.callId || "?"}): no "View/ Download IC PDF" link in the row.`);
  return { record, warnings };
}

/**
 * Parse the IC search result HTML and keep only the records that match the
 * expected PO number (IREPS already filters server-side by poNo, but the
 * portal has been known to echo unrelated rows on malformed searches, so
 * this is checked here too - "where practical" per the PO No. cell).
 *
 * @param {string} html
 * @param {string|null} [expectedPoNumber]
 * @param {{ DOMParser?: typeof DOMParser, baseUrl?: string, sourceUrl?: string|null, startIndex?: number }} [options]
 * @returns {ReturnType<typeof resultEnvelope> & { filteredCount: number }}
 */
export function parseIcSearchResults(html, expectedPoNumber = null, options = {}) {
  const Parser = options.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error("DOMParser is not available in this context");
  const source = String(html || "");
  const doc = new Parser().parseFromString(source, "text/html");
  // the page's own rules that hide cells, before stripDangerousNodes() drops its <style> (9.2)
  const hidingClasses = pageHidingClasses(doc);
  // On the real page the result table sits INSIDE <form name="inspectionCallForm">
  // (its navigate() paging submits that form). stripDangerousNodes() removes <form>
  // elements together with their contents, so unwrap them first - the table is kept,
  // the form (and every script / handler) is still dropped.
  for (const form of Array.from(doc.querySelectorAll("form"))) form.replaceWith(...Array.from(form.childNodes));
  stripDangerousNodes(doc);

  const warnings = [];
  const records = [];
  let rowCount = 0;
  let filteredOut = 0;
  const startIndex = Number(options.startIndex) > 0 ? Number(options.startIndex) : 1;
  // compared as the PO search compares it (comparablePoNo): "l325..." typed is IREPS's "L325..." (6.6)
  const wantPo = expectedPoNumber ? comparablePoNo(expectedPoNumber) : null;

  const located = locateResultTable(doc, { matchHeader: matchIcHeader, requiredKeys: ["callId"], minColumns: 8 });
  if (located) {
    const { table, headerRow, keys, labels } = located;
    const group = { values: {} };
    let ordinal = startIndex;
    const widest = Math.max(0, ...Array.from(table.rows).filter((r) => r !== headerRow && !isMarkupHeaderRow(r)).map((r) => visibleCells(r, hidingClasses).length));
    const extra = widest > keys.length ? widest - keys.length : 0;
    for (const row of Array.from(table.rows)) {
      if (row === headerRow || isMarkupHeaderRow(row)) continue;
      if (visibleCells(row, hidingClasses).length < 6) continue; // spacer / message rows
      rowCount++;
      const { record, warnings: rowWarnings } = parseIcRow(row, { labels, keys, extra }, group, ordinal, { baseUrl: options.baseUrl, hidingClasses });
      warnings.push(...rowWarnings);
      if (!record.callId) continue; // unreadable row, not counted as a record
      if (wantPo && record.poNo && comparablePoNo(record.poNo) !== wantPo) {
        filteredOut++;
        continue;
      }
      record.id = `ic-${record.callId}`;
      records.push(record);
      ordinal++;
    }
  }

  return {
    ...resultEnvelope("IREPS Inspection Call List", source, {
      sourceUrl: options.sourceUrl,
      structure: located ? "table" : "none",
      headerLabels: located ? located.labels : [],
      rowCount,
      skippedCount: filteredOut,
      records,
      warnings
    }),
    filteredCount: filteredOut
  };
}
