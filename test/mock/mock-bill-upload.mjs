/**
 * Mock of the IREPS supplier bill endpoints and of the ECM calls the bill upload makes, for
 * trying "Upload Bill to IREPS" without creating real draft bills (upload.md, section 4).
 * Wired into mock-ireps-server.mjs; answers in the captured formats.
 *
 * IREPS (session cookie required, like the rest of the mock):
 *   POST /epsn/ct/fetchPODetails.do          rly, poKey -> bill page (test/fixtures/bill-form-page.html filled in)
 *   POST /epsn/ct/populatePayAuthList.do     success^^<code>-<rly>^^<label>
 *   POST /epsn/ct/populatePOSrList.do        success^^001 only for the PO's stock / non-stock flag
 *   POST /epsn/common/getAjaxData.do         GSTIN status (the three supplier GSTINs are valid)
 *   POST /epsn/ct/saveBillHeader.do          checks every field, refuses a reused invoice no., -> success^^<billRegNo>
 *   POST /epsn/ct/fetchPOItemDetails.do      item blocks (@#$% / ^^) for a saved header
 *   POST /epsn/ct/populateROList.do          success^^1^^<roNo>
 *   POST /epsn/ct/populateRODetails.do       receipt details (item value = qty x rate x 1.18)
 *   POST /epsn/ct/saveBillDetails.do         checks the claim against the max claim -> success^^<dispatchNo>^^...
 *   GET/POST /epsn/ct/generateBillPreview.do a plain draft-bill summary
 * Two receipts of the R-NOTE fixture (rnote-results-real.html) can be billed: poKey 1000001
 * (TPI, Hosur invoice, Andhra Pradesh consignee) and 1000004 (CONSG, Rohtak invoice, Assam).
 * A receipt with a draft bill shows its bill reg no. in the R-NOTE results (markDraftBills()).
 *
 * ECM (point DocLink at it with config.local.json "ecm": { "domain": "http://localhost:8765" }):
 *   POST /nuxeo/oauth2/token                                  -> a mock bearer token
 *   POST /nuxeo/site/api/v1/automation/RetrieveInvoiceData    -> the matching mock invoice (a list)
 *   GET  /nuxeo/api/v1/search/lang/NXQL/execute               -> the invoice's / PO's mock documents
 *   GET  /nuxeo/api/v1/id/{uid}/@blob/file:content            -> a small PDF
 * Only these calls are mocked: IC / PO / MA "Save to ECM" uploads need the real ECM.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPANY = "SAMPLE RAIL SUPPLIES PVT LTD-UNIT A";
const VENDOR = "833";
const SUPPLIER_GSTINS = { "06AAGCS8525B1ZI": "1013:Haryana", "02AAGCS8525B1ZQ": "1002:Himachal Pradesh", "33AAGCS8525B1ZL": "1033:Tamil Nadu" };
const MOCK_TOKEN = "mock-ecm-token";

/** The billable receipts of the R-NOTE fixture, by poKey. */
const BILLS = {
  1000001: {
    rly: "11", railwayName: "East Coast Railway", poKey: "1000001", poNumber: "11260000100001", poDate: "01/07/2026", unit: "14651", nitOid: "100000001",
    payAuth: "A1001-11^^PFA/ECoR/BBS(A1001)-3101-ECOR", stockNonstock: "S", poSr: "001", plNo: "29160388", description: "KIT FOR DIST EQUIPMENT MANIFOLD ASSLY (MOCK)",
    deliveryDate: "19/10/2026", allocation: "20712804", qty: 87, rate: 7916, uom: "Set", unitCode: "03", gst: 18,
    consignee: "004800^^DLS/VSKP (Andhra Pradesh, GST# 37AAAGM0289C1ZI)", inspection: "TPI",
    roNo: "48300000001", roDate: "14/10/2026", drr: "RT000001", rNote: "4800000001", rNoteDate: "14/10/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/11/4800000001.pdf"
  },
  1000004: {
    rly: "05", railwayName: "North East Frontier Railway", poKey: "1000004", poNumber: "05260000100004", poDate: "20/05/2026", unit: "18870", nitOid: "100000004",
    payAuth: "A3001-05^^DFM/GHY(A3001)-0519-NFR", stockNonstock: "S", poSr: "001", plNo: "335200790028", description: "CARBON STRIP FOR PANTOGRAPH (MOCK)",
    deliveryDate: "01/09/2026", allocation: "20712808", qty: 15, rate: 27445, uom: "Number", unitCode: "01", gst: 18,
    consignee: "35294^^SSE/C/IC/KYQ (Assam, GST# 18AAAGM0289C1ZI)", inspection: "CONSG",
    roNo: "44000000004", roDate: "04/09/2026", drr: "R0000004", rNote: "4400000004", rNoteDate: "04/09/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/05/4400000004.pdf"
  }
};

/** The ECM's Oracle invoice rows for those receipts (sheet "Oracle data available in ECM" columns). */
const INVOICES = [
  {
    invoiceNumber: "1331000901", salesInvoiceDate: "2026-10-14 00:00:00.000", onivla: 812656.56, quantity: 87, offeredQuantity: 87, rate: 7916, totalTaxValue: 123964.56,
    taxCode: "IGST", serviceAccountingCode: "86072100", customerPONumber: "11260000100001", customerPOSrNumber: "001", division: "WABHSR",
    gstinRecipient: "37AAAGM0289C1ZI", supplyPlace: "DLS/VSKP", consigneeLocation: "VISAKHAPATNAM", consigneeAddressLine4: "VISAKHAPATNAM, AP, 530001, IN",
    partDescription: "KIT FOR DIST EQUIPMENT MANIFOLD ASSLY", "Sent to Doculink": ""
  },
  {
    invoiceNumber: "1061000902", salesInvoiceDate: "2026-09-02 00:00:00.000", onivla: 485776.5, quantity: 15, offeredQuantity: 15, rate: 27445, totalTaxValue: 74101.5,
    taxCode: "IGST", serviceAccountingCode: "85452000", customerPONumber: "05260000100004", customerPOSrNumber: "001", division: "WABRTK",
    gstinRecipient: "18AAAGM0289C1ZI", supplyPlace: "Coaching Depot/Guwahati", consigneeLocation: "GUWAHATI", consigneeAddressLine4: "GUWAHATI, AS, 781001, IN",
    partDescription: "CARBON STRIP FOR PANTOGRAPH", "Sent to Doculink": ""
  }
];

/** Which document types the mock ECM holds per invoice (IC only for the TPI bill, E-Dispatch Note only for the CONSG one). */
const DOCUMENTS = {
  "1331000901": ["generatedMerge", "garrantyWarrantyCertificate", "modvatDeclarationCertificate", "workCertificate"],
  "1061000902": ["generatedMerge", "garrantyWarrantyCertificate", "modvatDeclarationCertificate", "workCertificate", "eDispatchNote"],
  "11260000100001": ["inspectionCertificate", "poCopy"],
  "05260000100004": ["poCopy"]
};

const HEADER_FIELDS = [
  "invoiceAmount", "invoiceType", "payingRly", "stockNonstock", "fuelNonFuel", "multiInvoiceFlag", "invoiceCount", "billType", "spmBillRegNo", "organization",
  "department", "unit", "rly", "poKey", "poNumber", "poDate", "companyName", "pvc", "svcFlag", "gstFlag", "gstRegFlag", "reverseChargeFlag", "compositeFlag",
  "supplierGSTIN", "vendorCode", "payingAuthorityCode", "invoiceNo", "invoiceDate", "paymentType", "paymentPercent", "bankAccountNo", "ifscCode",
  "billDescription", "placeOfSupply", "stateOfSupply", "supplierState", "ipasAUCode", "nitOid", "supplementaryBillType", "paymentCode", "additionalPayment",
  "totalAmount", "rcvIdStr", "rcvRefundClaimAmtStr", "rrlNoStr", "rrlDateStr", "rrlValueStr", "totalBalanceAmtWraDouble"
];

let nextBillRegNo = 3900001;
let nextDispatchNo = 4900001;
/** billRegNo -> { bill, header, dispatchNo } */
const drafts = new Map();
const usedInvoices = new Set();

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const itemValue = (b) => round2(b.qty * b.rate + round2((b.qty * b.rate * b.gst) / 100));

function billPage(fixtures, b) {
  const v = { ...b, vendor: VENDOR, companyName: COMPANY };
  return readFileSync(join(fixtures, "bill-form-page.html"), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) => (v[k] === undefined ? "" : String(v[k])));
}

function draftFor(poKey) {
  for (const [regNo, d] of drafts) if (d.bill.poKey === poKey) return { regNo, ...d };
  return null;
}

/**
 * R-NOTE results: a receipt with a mock draft bill loses its Bill Claim link and shows the
 * bill reg no. in the Bill Reg No. cell, as the portal does.
 */
export function markDraftBills(rowsHtml) {
  return rowsHtml.replace(/<tr style="line-height: 26px;" class="trPoRow">[\s\S]*?<\/tr>/g, (row) => {
    const m = /fetchPODetails\.do\?rly=\d+&poKey=(\d+)/.exec(row);
    const draft = m ? draftFor(m[1]) : null;
    if (!draft) return row;
    return row
      .replace(/<a href="#" onclick="postRequest\('\/epsn\/ct\/fetchPODetails\.do[^"]*"[^>]*>[\s\S]*?<\/a>/, "")
      .replace(/generateBillPreview\.do\?billRegNo='\)" title="([^"]*)" >\s*<\/a>/, `generateBillPreview.do?billRegNo=${draft.regNo}')" title="$1" >${draft.regNo}</a>`);
  });
}

const fail = (text) => text;

/**
 * Handle a bill / ECM request; returns true when it did.
 * @param {{ req, res, path: string, url: URL, html: Function, readBody: Function, hasSession: Function, pages: object, fixtures: string, tinyPdf: Function, scenario: () => string }} h
 */
export async function handleBillUpload(h) {
  const { req, res, path, url } = h;
  const text = (status, body, type = "text/html;charset=UTF-8") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
    return true;
  };
  const json = (status, body) => text(status, JSON.stringify(body), "application/json");

  /* ------------------------------------------------------------- ECM */
  if (path.startsWith("/nuxeo/")) {
    if (path === "/nuxeo/oauth2/token" && req.method === "POST") return json(200, { access_token: MOCK_TOKEN, token_type: "bearer", expires_in: 3600 });
    if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}`) return json(401, { message: "mock ECM: bearer token required" });
    if (path === "/nuxeo/site/api/v1/automation/RetrieveInvoiceData" || path === "/nuxeo/api/v1/automation/RetrieveInvoiceData") {
      const params = (JSON.parse((await h.readBody(req)) || "{}").params) || {};
      console.log(`[mock-ecm] RetrieveInvoiceData ${JSON.stringify(params)}`);
      const hits = INVOICES.filter((i) => i.customerPONumber === params.customerPO && i.customerPOSrNumber === params.customerPOSrNo && String(i.quantity) === String(params.invoiceQuantity));
      return json(200, hits);
    }
    if (path === "/nuxeo/api/v1/search/lang/NXQL/execute") {
      const nxql = url.searchParams.get("query") || "";
      const types = (/type IN \(([^)]*)\)/.exec(nxql) || [, ""])[1].split(",").map((t) => t.trim().replace(/^'|'$/g, "")).filter(Boolean);
      const number = (/(?:invoiceNumber|customerPONumber) = '([^']*)'/.exec(nxql) || [])[1];
      const held = (DOCUMENTS[number] || []).filter((t) => types.includes(t));
      console.log(`[mock-ecm] NXQL ${number}: ${held.join(", ") || "nothing"}`);
      return json(200, {
        entries: held.map((type) => ({ uid: `mock-${type}-${number}`, title: `${number} - ${type}`, properties: { "InvoiceCertificateSchema:type": type, "dc:title": `${number} - ${type}`, "file:content": { name: `${number}_${type}.pdf` } } })),
        isNextPageAvailable: false
      });
    }
    const blob = /^\/nuxeo\/api\/v1\/id\/([^/]+)\/@blob\/file:content$/.exec(path);
    if (blob) {
      const uid = decodeURIComponent(blob[1]);
      const pdf = h.tinyPdf(["DOCLINK MOCK ECM DOCUMENT", uid, "Generated by the DocLink mock server for testing."]);
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "Content-Disposition": `attachment; filename="${uid}.pdf"` });
      res.end(pdf);
      return true;
    }
    return json(404, { message: `mock ECM: ${path} is not mocked` });
  }

  /* ------------------------------------------------------------- IREPS */
  const billPaths = ["/epsn/ct/fetchPODetails.do", "/epsn/ct/populatePayAuthList.do", "/epsn/ct/populatePOSrList.do", "/epsn/common/getAjaxData.do", "/epsn/ct/saveBillHeader.do",
    "/epsn/ct/fetchPOItemDetails.do", "/epsn/ct/populateROList.do", "/epsn/ct/populateRODetails.do", "/epsn/ct/saveBillDetails.do", "/epsn/ct/generateBillPreview.do"];
  if (!billPaths.includes(path)) return false;
  const body = req.method === "POST" ? await h.readBody(req) : "";
  const form = new URLSearchParams(body);
  for (const [k, v] of url.searchParams) if (!form.has(k)) form.set(k, v);
  console.log(`[mock-ireps] ${req.method} ${path.split("/").pop()}  ${Array.from(form.keys()).length} fields  cookie=${h.hasSession(req) ? "yes" : "no"}`);
  if (!h.hasSession(req) || ["login", "expired"].includes(h.scenario())) return text(200, h.pages.login);
  if (h.scenario() === "http500") return text(500, "<html><body><h1>HTTP Status 500 - Internal Server Error</h1></body></html>");

  const bill = BILLS[form.get("poKey")] || Object.values(BILLS).find((b) => b.poNumber === form.get("poNumber"));

  if (path === "/epsn/ct/fetchPODetails.do") {
    if (!bill) return text(200, "<html><body><span class='errorStyle'>No Purchase Order found for this claim.</span></body></html>");
    return text(200, billPage(h.fixtures, bill));
  }
  if (path === "/epsn/common/getAjaxData.do") {
    const gstin = form.get("gstNo") || "";
    return text(200, SUPPLIER_GSTINS[gstin] ? `${SUPPLIER_GSTINS[gstin]}^false^Valid GSTIN^${gstin}^${COMPANY}^^^^^^Y^Jun 8, 2021 12:00:00 PM^GSTIN Found in Local DB^Regular` : `0:^Invalid GSTIN^${gstin}`);
  }
  if (path === "/epsn/ct/generateBillPreview.do") {
    const d = drafts.get(form.get("billRegNo"));
    if (!d) return text(200, "<html><body>No draft bill.</body></html>");
    const rows = Object.entries({ ...d.header, dispatchNo: d.dispatchNo || "(item not saved)" }).filter(([k]) => !/bankAccountNo|ifscCode/.test(k)).map(([k, v]) => `<tr><td>${k}</td><td>${String(v).replace(/</g, "&lt;")}</td></tr>`).join("");
    return text(200, `<html><head><title>Bill Preview (mock)</title></head><body><h2>Draft supplier bill ${form.get("billRegNo")} (mock)</h2><table border="1">${rows}</table><p>Signing is not mocked.</p></body></html>`);
  }
  if (!bill) return text(200, fail("No PO details found."));

  switch (path) {
    case "/epsn/ct/populatePayAuthList.do":
      return text(200, `success^^${bill.payAuth}`);
    case "/epsn/ct/populatePOSrList.do":
      return text(200, form.get("stockNonstock") === bill.stockNonstock ? `success^^${bill.poSr}` : "success");
    case "/epsn/ct/saveBillHeader.do": {
      const missing = HEADER_FIELDS.filter((k) => !form.has(k));
      if (missing.length) return text(200, fail(`Missing field(s): ${missing.join(", ")}`));
      if (!/^[A-Za-z0-9\-/]{1,16}$/.test(form.get("invoiceNo"))) return text(200, fail("Only - and / are allowed as special characters in Invoice No!"));
      if (usedInvoices.has(form.get("invoiceNo"))) return text(200, fail(`Bill already registered for Invoice No. ${form.get("invoiceNo")}.`));
      if (!SUPPLIER_GSTINS[form.get("supplierGSTIN")]) return text(200, fail("Supplier GSTIN is invalid"));
      const regNo = String(nextBillRegNo++);
      usedInvoices.add(form.get("invoiceNo"));
      drafts.set(regNo, { bill, header: Object.fromEntries(form), dispatchNo: null });
      console.log(`[mock-ireps] draft bill ${regNo} created for PO ${bill.poNumber} / invoice ${form.get("invoiceNo")}`);
      return text(200, `success^^${regNo}`);
    }
    case "/epsn/ct/fetchPOItemDetails.do": {
      if (!drafts.has(form.get("billRegNo"))) return text(200, fail("Invalid Bill Reg No."));
      return text(200, `success@#$%${bill.poSr}^^${bill.plNo}^^${bill.description}^^${bill.deliveryDate}^^${bill.allocation}^^${bill.qty}^^${bill.rate}^^${bill.uom}^^${bill.unitCode}^^1@#$%%^^-1^^-1^^U^^-1^^%^^-1^^-1@#$%0^^0^^0^^0^^0^^${bill.gst}^^0^^0@#$%NA^^NA@#$%0^^${bill.consignee}^^null^^null^^null@#$%${bill.inspection}@#$%NA@#$%disabled`);
    }
    case "/epsn/ct/populateROList.do":
      return text(200, `success^^1^^${bill.roNo}`);
    case "/epsn/ct/populateRODetails.do": {
      if (form.get("roNo") !== bill.roNo) return text(200, fail("Invalid RO No."));
      const value = itemValue(bill);
      return text(200, `success^^${bill.roDate}^^${bill.qty}^^${bill.drr}^^0^^${bill.rNote}^^${bill.rNoteDate}^^0^^ ${bill.rNote}:${bill.qty}^^^^${bill.qty}.0^^^^${value}^^0^^${value}^^http://www.ireps.gov.in${bill.rnUrl}`);
    }
    case "/epsn/ct/saveBillDetails.do": {
      const d = drafts.get(form.get("billRegNo"));
      if (!d) return text(200, fail("Invalid Bill Reg No."));
      if (d.dispatchNo) return text(200, fail("Item already saved for this bill."));
      const claim = Number(form.get("totalAmount"));
      const max = Number(form.get("maxClaim"));
      if (!(claim > 0)) return text(200, fail("Please enter Item Wise Claim by vendor"));
      if (claim > max) return text(200, fail(`Please enter a claim amount not exceeding ${max}`));
      d.dispatchNo = String(nextDispatchNo++);
      const now = new Date();
      const stamp = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      console.log(`[mock-ireps] item saved on bill ${form.get("billRegNo")} (dispatch ${d.dispatchNo}, claim ${claim})`);
      return text(200, `success^^${d.dispatchNo}^^${claim}^^${form.get("rlyGSTIN")}^^OK#1<>${bill.roNo}.pdf#${bill.rnUrl.slice(1)}#RNOTE / CRN - SYSTEM UPLOAD#${stamp}#MOCK USER#1<>`);
    }
    default:
      return false;
  }
}
