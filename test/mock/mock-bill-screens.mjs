/**
 * The screens of the mock bill flow, following "BILL SUBMISSION-Screen shot of IREPS.docx":
 *
 *   Screen 3   PO page, R/NOTES tab             POST /epsn/supply/ct/showReceiptNotes.do
 *   Screen 4   PO page, BILLS FOR PAY tab       POST /epsn/ct/showSubmittedBills.do
 *   Screens 5-9  Bill Data Entry                POST /epsn/ct/fetchPODetails.do (bill-entry-page.html)
 *   Screen 10  Bill preview                     POST /epsn/ct/generateBillPreview.do
 *   Screen 11  Sign & submit (simulated)        POST /epsn/ct/generatePDF.do
 *
 * Plus two mock-only pages that are not part of the portal:
 *   /mock/bill/         test hub: the receipts, what each one tests, reset
 *   /mock/bill/check    field check: every value the mock received against what was expected
 *
 * Pure rendering: the data and the state live in mock-bill-upload.mjs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** JSON that is safe inside a <script> block. */
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

export const STATES = [
  ["35", "Andaman And Nicobar"], ["37", "Andhra Pradesh"], ["12", "Arunachal Pradesh"], ["18", "Assam"], ["10", "Bihar"], ["04", "Chandigarh"], ["22", "Chhattisgarh"],
  ["26", "Dadra & Nagar Haveli and Daman & Diu"], ["07", "Delhi"], ["30", "Goa"], ["24", "Gujarat"], ["06", "Haryana"], ["02", "Himachal Pradesh"], ["01", "Jammu And Kashmir"],
  ["20", "Jharkhand"], ["29", "Karnataka"], ["32", "Kerala"], ["38", "Ladakh"], ["31", "Lakshadweep"], ["23", "Madhya Pradesh"], ["27", "Maharashtra"], ["14", "Manipur"],
  ["17", "Meghalaya"], ["15", "Mizoram"], ["13", "Nagaland"], ["21", "Odisha"], ["34", "Puducherry"], ["03", "Punjab"], ["08", "Rajasthan"], ["11", "Sikkim"], ["33", "Tamil Nadu"],
  ["36", "Telangana"], ["16", "Tripura"], ["09", "Uttar Pradesh"], ["05", "Uttarakhand"], ["19", "West Bengal"]
];
const RAILWAY_GSTINS = [
  ["18AAAGM0289C1ZI", "Assam"], ["29AAAGM0289C1ZF", "Karnataka"], ["33AAAGM0289C1ZQ", "Tamil Nadu"], ["37AAAGM0289C1ZI", "Andhra Pradesh"], ["04AAAGM0289C1ZR", "Chandigarh"],
  ["09AAAGM0289C1ZH", "Uttar Pradesh"], ["18AAACI0681C1ZY", "~Assam-IRFC"]
];
const IGST_RATES = ["1", "2", "3", "5", "8.9", "12", "13.8", "18", "28", "40"];
const CGST_RATES = ["0.5", "1", "1.5", "2.5", "4.45", "6", "6.9", "9", "14", "20"];

const options = (list) => list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");

const SHELL_STYLE = `<style>
  body { margin: 0; font: 12px Verdana, Arial, sans-serif; color: #111; background: #fff; }
  .mockStrip { background: #fff3cd; border-bottom: 1px solid #b58900; padding: 5px 12px; font-weight: bold; color: #6b5200; }
  .mockStrip a { color: #124a8c; margin-left: 10px; font-weight: normal; }
  .portalHead { background: #0a2233; color: #fff; text-align: center; padding: 8px; font-size: 20px; line-height: 1.25; }
  .portalHead small { display: block; color: #ffd400; font-size: 18px; }
  .portalBar { background: #0a2233; color: #fff; border-top: 1px solid #456; padding: 4px 16px; font-weight: bold; display: flex; justify-content: space-between; }
  .portalBar a { color: #fff; margin-left: 14px; }
  .page { max-width: 1120px; margin: 12px auto; padding: 0 12px; }
  .poTabs { border: 1px solid #5a8a7a; background: #f4f8f6; padding: 6px; }
  .tab { display: inline-block; background: #0a84c6; color: #fff !important; font-weight: bold; padding: 4px 8px; margin: 1px; text-decoration: none; font-size: 11px; }
  .tab.active { background: #d9541e; }
  .poInfo { display: flex; flex-wrap: wrap; gap: 8px 40px; padding: 10px 4px; }
  .grid { width: 100%; border-collapse: collapse; margin-top: 12px; }
  .grid th { background: #45cfc9; padding: 7px 5px; text-align: left; }
  .grid td { border-bottom: 1px solid #bbb; padding: 7px 5px; vertical-align: top; }
  .linkRed { color: #d00000; font-weight: bold; }
  .ok { color: #137a3d; font-weight: bold; } .bad { color: #c0392b; font-weight: bold; } .muted { color: #666; }
</style>`;

const MOCK_STRIP = `<div class="mockStrip">MOCK IREPS: fictitious test data. Nothing here reaches the real portal.<a href="/mock/bill/">Bill test hub</a><a href="/epsn/searchPO.do?searchParam=showPage">PO Search</a></div>`;

function portalHeader(user) {
  return `<div class="portalHead">Government eMarketplace<small>Indian Railways E-Procurement System (MOCK)</small></div>
<div class="portalBar"><span>${esc(user)}</span><span><a href="/epsn/home/showHome.do">Home</a><a href="/epsn/home/logout.do">Logout</a></span></div>`;
}

function page(title, body, { user }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<script src="/ireps/js/jquery.1.11.1.js"></script><script src="/ireps/js/works/postRequest.js"></script>${SHELL_STYLE}</head>
<body>${MOCK_STRIP}${portalHeader(user)}<div class="page">${body}</div></body></html>`;
}

const postLink = (url, text, cls = "") => `<a href="#" class="${cls}" onclick="postRequest('${url}');return false;">${esc(text)}</a>`;
const poParams = (b) => `rly=${b.rly}&poKey=${b.poKey}&poNo=${b.poNumber}`;

/** The PO box with its tabs (screens 3 and 4). */
export function poHeader(b, active) {
  const tabs = ["DISPATCH DETAILS", "MA REQ.", ["BILLS FOR PAY.", "/epsn/ct/showSubmittedBills.do"], "RECT CHALLANS", ["R/NOTES", "/epsn/supply/ct/showReceiptNotes.do"], "CRC (UDM)", ["CRN (UDM)", "/epsn/supply/ct/showReceiptNotes.do"], "REJECTION", "INSPECTIONS", "BANK DTLS."];
  const html = tabs.map((t) => {
    if (typeof t === "string") return `<span class="tab" style="opacity:.55" title="Not mocked">${esc(t)}</span>`;
    const on = t[0] === active;
    return `<a href="#" class="tab${on ? " active" : ""}" onclick="postRequest('${t[1]}?${poParams(b)}');return false;">${esc(t[0])}</a>`;
  }).join("");
  return `<div class="poTabs">${html}
  <div class="poInfo"><span><b>PO No.:</b> ${esc(b.poNumber)}</span><span><b>Dept/Rly:</b> ${esc(b.railwayName)}</span><span><b>PO Date:</b> ${esc(b.poDate)}</span><span><b>PO Status:</b> Order Placed</span></div>
  <div style="padding:0 4px 4px"><b>PO Title:</b> ${esc(b.description)}</div></div>`;
}

/** Screen 3: the PO's receipts, with the Bill Claim icon when a bill can be claimed. */
export function receiptNotesPage(b, draft, user) {
  const signed = draft && draft.status === "Signed";
  const claim = draft
    ? (signed ? "Signed" : "Draft")
    : postLink(`/epsn/ct/fetchPODetails.do?rly=${b.rly}&poKey=${b.poKey}`, "Claim", "tab");
  const isCrn = b.source === "CRN";
  const body = `${poHeader(b, isCrn ? "CRN (UDM)" : "R/NOTES")}
  <table class="grid"><thead><tr><th>#</th><th>PO Sr</th><th>PO Qty</th><th>${isCrn ? "CRN No. &amp; Date" : "RNote No. &amp; Date"}</th><th>${isCrn ? "CRN" : "RNote"} Qty</th><th>Challan No. &amp; Date</th><th>DRR No.</th><th>RO No. &amp; Date</th><th>Bill Claim</th><th>Bill Reg No.</th><th>Invoice No.</th></tr></thead>
  <tbody><tr><td>1</td><td>${esc(b.poSr)}</td><td>${b.qty} ${esc(b.uom)}</td><td>${esc(isCrn ? b.roNo : b.rNote)}<br>${esc(b.rNoteDate)}</td><td>${b.qty} ${esc(b.uom)}</td><td>${esc(b.invoiceNumber)}<br>${esc(b.rNoteDate)}</td><td>${esc(b.drr)}</td><td>${esc(b.roNo)}<br>${esc(b.roDate)}</td><td>${claim}</td><td>${draft ? esc(draft.regNo) : ""}</td><td>${draft ? esc(draft.header.invoiceNo) : ""}</td></tr></tbody></table>`;
  return page("Request for Amendments by Vendor", body, { user });
}

/** Screen 4: the PO's bills and "Submit New Bill". A draft can be reopened here. */
export function submittedBillsPage(b, draft, user) {
  const rows = draft
    ? `<tr><td>1</td><td>${esc(draft.regNo)}</td><td>${esc(draft.createdOn)}</td><td>${esc(draft.header.invoiceNo)}</td><td>${esc(draft.header.invoiceDate)}</td><td>${draft.header.paymentType === "F" ? "Final" : "Advance"}</td><td>${esc(draft.header.payingAuthorityCode)}</td><td>${esc(draft.header.invoiceAmount)}</td><td>${esc(draft.status)}</td>
    <td>${postLink(`/epsn/ct/fetchPODetails.do?rly=${b.rly}&poKey=${b.poKey}&billRegNo=${draft.regNo}`, "Open bill")} &middot; <a href="/mock/bill/check?billRegNo=${draft.regNo}">Field check</a></td></tr>`
    : `<tr><td colspan="10" style="text-align:center;color:#c00;font-style:italic">No Record Found.</td></tr>`;
  const body = `${poHeader(b, "BILLS FOR PAY.")}
  <p class="linkRed" style="margin-top:12px">${draft ? "" : postLink(`/epsn/ct/fetchPODetails.do?rly=${b.rly}&poKey=${b.poKey}`, "Submit New Bill", "linkRed")}</p>
  <table class="grid"><thead><tr><th>#</th><th>IREPS Bill Reg No.</th><th>Registered on</th><th>Invoice No.</th><th>Invoice Date</th><th>Adv/Final</th><th>Paying Authority</th><th>Bill Amt.</th><th>Bill Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  return page("Choose your Billing Option", body, { user });
}

const template = readFileSync(join(here, "bill-entry-page.html"), "utf8");

/** Screens 5-9. Without a draft, an empty form as "Bill Claim" opens it. With one, that bill's saved values. */
export function billEntryPage(b, { vendor, companyName, vendorAddress, supplierGstins, bank, ifsc, user, draft, check }) {
  const slots = {
    shellStyle: SHELL_STYLE,
    mockStrip: MOCK_STRIP,
    portalHeader: portalHeader(user),
    poHeader: poHeader(b, "BILLS FOR PAY."),
    checkPanel: draft ? checkPanel(draft, check) : "",
    draftJson: scriptJson(draft ? draftForPage(draft) : null),
    unit: esc(b.unit), rly: esc(b.rly), poKey: esc(b.poKey), poNumber: esc(b.poNumber), poDate: esc(b.poDate), nitOid: esc(b.nitOid), railwayName: esc(b.railwayName),
    vendor: esc(vendor), companyName: esc(companyName), vendorAddress: esc(vendorAddress), bankAccountNo: esc(bank), ifscCode: esc(ifsc),
    supplierGstinOptions: options(supplierGstins.map((g) => [g, g])),
    stateOptions: options(STATES),
    railwayGstinOptions: options(RAILWAY_GSTINS.map(([g, s]) => [g, `${g}-${s}`])),
    igstOptions: options(IGST_RATES.map((r) => [r, r])),
    cgstOptions: options(CGST_RATES.map((r) => [r, r]))
  };
  return template.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in slots ? slots[k] : all)).replace(/<!--[\s\S]*?-->\s*/, "");
}

function draftForPage(d) {
  return {
    billRegNo: d.regNo, createdBy: d.createdBy, status: d.status, dispatchNo: d.dispatchNo, header: d.header, item: d.item, documentsText: d.documentsText,
    gstinStatus: "Valid GSTIN", itemInfo: { qtyOrdered: `${d.bill.qty} ${d.bill.uom}`, consigneeName: d.bill.consignee.split("^^")[1], itemValue: d.itemValue, breakup: d.bill.source === "CRN" ? "NA" : `${d.bill.rNote}:${d.bill.qty}` }
  };
}

function checkPanel(d, check) {
  const verdict = check.summary;
  const link = `<a href="/mock/bill/check?billRegNo=${esc(d.regNo)}">Open the field check</a>`;
  if (d.createdBy !== "DocLink") return `<div class="mock-panel">Bill ${esc(d.regNo)} was typed on this mock screen, not sent by DocLink. ${link}</div>`;
  const cls = verdict.failed ? "mock-panel bad" : "mock-panel";
  return `<div class="${cls}"><b>Bill ${esc(d.regNo)}, sent by DocLink:</b> the boxes below show what IREPS received (green). ${verdict.passed} of ${verdict.checked} values match what was expected${verdict.failed ? `, <b>${verdict.failed} do not</b>` : ""}${verdict.noReference ? ` (${verdict.noReference} had nothing to compare with)` : ""}. ${link}</div>`;
}

const row = (label, value, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${esc(label)} : ${esc(value)}</td>`;

/** Screen 10 (and, once signed, the submitted bill). */
export function previewPage(d, user) {
  const { bill: b, header: h, item: i } = d;
  const docs = d.documents.map((x, n) => `<tr><td>${n + 1}</td><td>${esc(x.fileName)}</td><td>${esc(x.description)}</td><td>${esc(x.uploadedOn)}</td><td>${esc(x.uploadedBy)}</td></tr>`).join("") || `<tr><td colspan="5">No documents</td></tr>`;
  const interState = i && Number(i.igstRate) > 0;
  const taxRows = !i ? "" : interState
    ? `<tr>${row("IGST Rate", `${i.igstRate} %`)}${row("IGST Amount", i.igstAmount)}<td></td></tr>`
    : `<tr>${row("CGST Rate", `${i.cgstRate} %`)}${row("CGST Amount", i.cgstAmount)}<td></td></tr><tr>${row("SGST Rate", `${i.sgstRate} %`)}${row("SGST Amount", i.sgstAmount)}<td></td></tr>`;
  const signed = d.status === "Signed";
  const body = `
  <style>.pv{width:100%;border-collapse:collapse;margin-bottom:6px}.pv td,.pv th{border:1px solid #333;padding:4px 6px}.pv th{text-align:center}.pvBand{background:#e6e8fb;text-align:center;font-weight:bold}</style>
  <table class="pv"><tr>${row("PO No.", b.poNumber)}${row("PO Date", b.poDate)}${row("Bill Reg No.", d.regNo)}</tr>
  <tr>${row(b.source === "CRN" ? "CRN No." : "RNote No", i ? i.roNo === b.roNo && b.source === "CRN" ? b.roNo : i.rNoteNumber : "")}${row("RNote Date", i ? i.rNoteDate : "")}${row("DRR No.", i ? i.drrNumber : "")}</tr>
  <tr>${row("Inspection Agency", i ? i.inspectionAgency : "")}<td colspan="2"></td></tr>
  <tr>${row("Tax Invoice No.", h.invoiceNo)}${row("Tax Invoice Date", h.invoiceDate)}${row("Supplier GSTIN", h.supplierGSTIN)}</tr>
  <tr>${row("GST Category", i && i.gstCategory === "0" ? "Regular GST (As per payment %)" : i ? i.gstCategory : "")}${row("HSN Code", i ? i.hsnCode : "")}${row("RLY GSTIN", i ? i.rlyGSTIN : "")}</tr>
  <tr>${row("Buying Unit", b.uom)}${row("PO Rate", i ? i.poRate : "")}<td></td></tr>
  ${taxRows}
  <tr>${row("Taxable Amount", i ? i.expenseAmount : "")}${row("Tax Amount", i ? i.basicAmount : "")}${row("Amount Claimed", i ? i.totalAmount : "")}</tr></table>
  <table class="pv"><tr><td class="pvBand" colspan="5">Uploaded Documents</td></tr><tr><th>Sr.No.</th><th>File Name</th><th>File Description</th><th>Uploaded On</th><th>Uploaded By</th></tr>${docs}</table>
  <table class="pv"><tr><td><b>Declaration</b><br>* I have personally examined and verified and do hereby certify that goods in respect of which payment is being claimed have been actually dispatched as per above details. (Mock text.)</td></tr></table>
  ${signed
    ? `<p class="ok">Bill ${esc(d.regNo)} submitted (mock). Status: Signed.</p>`
    : i
      ? `<form method="post" action="/epsn/ct/generatePDF.do" onsubmit="return confirm('Simulated signature: no real DSC or PIN is used. Submit this mock bill?');"><input type="hidden" name="billRegNo" value="${esc(d.regNo)}"><button type="submit">Sign &amp; Submit Bill (simulated)</button></form>`
      : `<p class="bad">The item is not saved yet, so this bill cannot be submitted.</p>`}
  <p><a href="/mock/bill/check?billRegNo=${esc(d.regNo)}">Field check</a></p>`;
  return page("Bill Preview", body, { user });
}

/* -------------------------------------------------------------------------- */
/* Mock-only pages                                                            */
/* -------------------------------------------------------------------------- */

const MOCK_PAGE_STYLE = `<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 1040px; margin: 24px auto; padding: 0 16px; color: #1c2430; }
  h1 { font-size: 24px; margin-bottom: 4px; } h2 { font-size: 17px; margin-top: 26px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border-bottom: 1px solid #d5dbe3; padding: 7px 8px; text-align: left; vertical-align: top; }
  th { background: #eef2f7; }
  code { background: #eef2f7; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  pre { background: #eef2f7; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  a { color: #124a8c; } .ok { color: #137a3d; font-weight: 600; } .bad { color: #c0392b; font-weight: 600; } .muted { color: #667; }
  .banner { padding: 10px 14px; border-radius: 6px; margin: 12px 0; } .banner.ok { background: #e6f8ec; } .banner.bad { background: #fdecea; } .banner.muted { background: #eef2f7; }
  button { padding: 6px 14px; font: inherit; cursor: pointer; }
</style>`;

const SOURCE_LABEL = { RNOTE: "R-Note", CRN: "CRN" };

/** The test hub. */
export function hubPage(bills, draftFor) {
  const rows = bills.map((b) => {
    const d = draftFor(b.poKey);
    const state = d ? `<a href="/mock/bill/check?billRegNo=${d.regNo}">Bill ${d.regNo}</a> (${esc(d.status)})` : `<span class="muted">No bill yet</span>`;
    return `<tr><td>${esc(b.poNumber)}<br><span class="muted">Sr ${esc(b.poSr)}, qty ${b.qty}</span></td><td>${SOURCE_LABEL[b.source]} ${esc(b.source === "CRN" ? b.roNo : b.rNote)}</td><td><b>${esc(b.scenario)}</b><br>${esc(b.expected)}</td><td>${state}</td></tr>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mock bill test hub</title>${MOCK_PAGE_STYLE}</head><body>
  <h1>Mock bill test hub</h1>
  <p class="muted">Test data for "Upload Bill to IREPS". Everything is fictitious, and nothing reaches the real portal.</p>
  <p><a href="/epsn/home/showHome.do">Mock portal</a> &middot; <a href="/epsn/searchPO.do?searchParam=showPage">PO Search</a> &middot; <a href="/mock/bill/invoices.json" download="mock-invoices.json">Download the invoice JSON</a> &middot; <a href="/mock/">Control panel</a></p>

  <h2>Receipts to test</h2>
  <table><thead><tr><th>PO</th><th>Receipt</th><th>What it tests</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>

  <h2>Test with DocLink</h2>
  <ol>
    <li>Log in to the <a href="/epsn/home/showHome.do">mock portal</a> and open DocLink on that tab. Then click <b>Bill</b> on the <b>Upload</b> card.</li>
    <li>Enter a PO number from the table and click <b>Find R-Notes / CRNs</b>. Select the receipt.</li>
    <li>Choose <b>From a JSON file</b> and pick the <a href="/mock/bill/invoices.json" download="mock-invoices.json">invoice JSON</a>, then click <b>Prepare bill</b>.</li>
    <li>Tick the confirmation and click <b>Create draft bill in IREPS</b>.</li>
    <li>Come back here and click the bill's number in the table to see the field check, or open the PO's <b>Bills for Pay</b> tab and click <b>Open bill</b> to see the values in the boxes.</li>
  </ol>

  <p><b>Find it in ECM</b> and <b>Get documents from ECM</b> also need DocLink pointed at this mock's ECM. Add this to <code>config.local.json</code> and reload DocLink. Remove it again before using the real ECM.</p>
  <pre>"ecm": { "domain": "http://localhost:8765", "clientId": "mock", "clientSecret": "mock" }</pre>

  <h2>Test by hand, as on the screenshots</h2>
  <p>PO Search &rarr; Receipt Note (R-NOTE) &rarr; Show Results &rarr; the Bill Claim icon &rarr; fill the header &rarr; Save Bill Header &rarr; Select PO Sr &rarr; fill the item &rarr; Save &rarr; Upload Documents &rarr; Generate Preview &rarr; Sign &amp; Submit (simulated). The values to type are in the invoice JSON.</p>

  <h2>Start again</h2>
  <form method="post" action="/mock/bill/reset" style="margin-bottom:10px"><button type="submit">Delete all mock bills</button></form>
  <p>DocLink keeps its own record of the bills it created, and that record survives this reset. Until it's cleared, DocLink refuses those receipts with "already created". To clear it, open <code>chrome://extensions</code>, click DocLink's <b>service worker</b> link, and run this in the Console:</p>
  <pre>chrome.storage.local.remove("doclink.billUploads")</pre>
  <p>Then click <b>Start over</b> in the panel.</p>
  </body></html>`;
}

const RESULT = { pass: `<span class="ok">Match</span>`, fail: `<span class="bad">Different</span>`, none: `<span class="muted">Nothing to compare</span>` };

/** The field check. */
export function checkPage(d, check) {
  const section = (name, list) => `<h2>${esc(name)}</h2><table><thead><tr><th>Box on the IREPS screen</th><th>Request field</th><th>IREPS received</th><th>Expected</th><th>Where the expected value comes from</th><th>Result</th></tr></thead><tbody>
  ${list.map((c) => `<tr><td>${esc(c.label)}</td><td><code>${esc(c.field)}</code></td><td>${esc(c.received) || '<span class="muted">(empty)</span>'}</td><td>${c.expected === null ? "" : esc(c.expected)}</td><td class="muted">${esc(c.source)}</td><td>${RESULT[c.result]}</td></tr>`).join("")}</tbody></table>`;
  const s = check.summary;
  const banner = !d.item && !s.failed
    ? `<div class="banner muted">The header matches. The item isn't saved yet, so its values can't be checked.</div>`
    : s.failed
      ? `<div class="banner bad"><b>${s.failed} of ${s.checked} values do not match.</b></div>`
      : `<div class="banner ok"><b>All ${s.passed} values with a reference match.</b>${s.noReference ? ` ${s.noReference} had nothing to compare with.` : ""}</div>`;
  const docs = `<h2>Documents attached in IREPS</h2>
  <p class="muted">DocLink doesn't attach these. It saves them locally, and you attach them on the Bill Data Entry screen. This list uses DocLink's default descriptions, which the business hasn't confirmed yet.</p>
  <table><thead><tr><th>Document</th><th>Description to type</th><th>Needed for this bill?</th><th>Attached</th></tr></thead><tbody>
  ${check.documents.map((x) => `<tr><td>${esc(x.label)}</td><td><code>${esc(x.fileDesc)}</code></td><td>${esc(x.need)}</td><td>${x.attached ? `<span class="ok">${esc(x.attached)}</span>` : x.need === "Yes" ? '<span class="bad">Not yet</span>' : '<span class="muted">No</span>'}</td></tr>`).join("")}</tbody></table>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Field check ${esc(d.regNo)}</title>${MOCK_PAGE_STYLE}</head><body>
  <h1>Field check: bill ${esc(d.regNo)}</h1>
  <p class="muted">PO ${esc(d.bill.poNumber)}, invoice ${esc(d.header.invoiceNo)}. ${d.createdBy === "DocLink" ? "Sent by DocLink." : "Typed on the mock screen."} Status: ${esc(d.status)}.</p>
  <p><a href="/mock/bill/">Bill test hub</a> &middot; <a href="#" onclick="document.getElementById('open').submit();return false;">Open this bill on the IREPS screen</a></p>
  <form id="open" method="post" action="/epsn/ct/fetchPODetails.do"><input type="hidden" name="rly" value="${esc(d.bill.rly)}"><input type="hidden" name="poKey" value="${esc(d.bill.poKey)}"><input type="hidden" name="billRegNo" value="${esc(d.regNo)}"></form>
  ${banner}
  ${check.reference ? "" : '<div class="banner muted">This invoice number is not one of the mock invoices, so invoice values have nothing to compare with.</div>'}
  ${section("Bill header (screens 5 and 6)", check.header)}
  ${d.item ? section("Billing details (screen 8)", check.item) : ""}
  ${docs}
  </body></html>`;
}
