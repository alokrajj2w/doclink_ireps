/**
 * Mock of the IREPS supplier bill flow and of the ECM calls the bill upload makes, for trying
 * "Upload Bill to IREPS" without creating real draft bills (upload.md, section 4). Wired into
 * mock-ireps-server.mjs; answers in the captured formats. The screens are in mock-bill-screens.mjs
 * and bill-entry-page.html.
 *
 * IREPS (session cookie required, like the rest of the mock):
 *   POST /epsn/ct/fetchPODetails.do          rly, poKey -> Bill Data Entry; with billRegNo, that bill's saved values
 *   POST /epsn/ct/populatePayAuthList.do     success^^<code>-<rly>^^<label>
 *   POST /epsn/ct/populatePOSrList.do        success^^001 only for the PO's stock / non-stock flag
 *   POST /epsn/common/getAjaxData.do         GSTIN status (the three supplier GSTINs are valid)
 *   POST /epsn/ct/saveBillHeader.do          checks every field, refuses a reused invoice no., -> success^^<billRegNo>
 *   POST /epsn/ct/fetchPOItemDetails.do      item blocks (@#$% / ^^) for a saved header
 *   POST /epsn/ct/populateROList.do          success^^1^^<roNo>
 *   POST /epsn/ct/populateRODetails.do       receipt details (item value = qty x rate x 1.18)
 *   POST /epsn/ct/saveBillDetails.do         checks the claim against the max claim -> success^^<dispatchNo>^^...
 *   POST /cgi-bin/save.php                   multipart -> OK~<path>~<bytes> (the file is not kept)
 *   POST /epsn/ct/uploadBillDocuments.do     OK#<n><>rows
 *   POST /epsn/ct/deleteBillDocument.do      mock only: the real delete call was not captured
 *   POST /epsn/ct/generateBillPreview.do     screen 10
 *   POST /epsn/ct/generatePDF.do             simulated sign and submit: no signer, DSC or PIN
 *   POST /epsn/supply/ct/showReceiptNotes.do, /epsn/ct/showSubmittedBills.do   the PO's tabs (screens 3, 4)
 *   POST /epsn/dispatchParticulars/showDispatchParticular.do   for the POs below, opens the receipts tab
 *
 * Reopening a draft through "Open bill" on the Bills for Pay tab is a mock assumption: how the
 * portal reopens a draft to attach documents has not been captured (upload.md, section 11).
 *
 * ECM (point DocLink at it with config.local.json "ecm": { "domain": "http://localhost:8765" }):
 *   POST /nuxeo/oauth2/token                                  -> a mock bearer token
 *   POST /nuxeo/site/api/v1/automation/RetrieveInvoiceData    -> the matching mock invoice (a list)
 *   GET  /nuxeo/api/v1/search/lang/NXQL/execute               -> the invoice's / PO's mock documents
 *   GET  /nuxeo/api/v1/id/{uid}/@blob/file:content            -> a small PDF
 * Only these calls are mocked: IC / PO / MA "Save to ECM" uploads need the real ECM.
 *
 * Mock only (no session needed):
 *   /mock/bill/  test hub   /mock/bill/check[.json]?billRegNo=   /mock/bill/invoices.json   POST /mock/bill/reset
 */

import { hubPage, checkPage, billEntryPage, previewPage, receiptNotesPage, submittedBillsPage, esc } from "./mock-bill-screens.mjs";

const COMPANY = "SAMPLE RAIL SUPPLIES PVT LTD-UNIT A";
const VENDOR = "833";
const VENDOR_ADDRESS = "1 SAMPLE INDUSTRIAL AREA, City: HOSUR, Zip: 000000, Tamil Nadu, India";
const USER = `MOCK USER, ${COMPANY} (IREPS ID- ${VENDOR})`;
const BANK = "000111222333";
const IFSC = "TEST0000001";
const SUPPLIER_GSTINS = { "06AAGCS8525B1ZI": "1013:Haryana", "02AAGCS8525B1ZQ": "1002:Himachal Pradesh", "33AAGCS8525B1ZL": "1033:Tamil Nadu" };
const GSTIN_BY_DIVISION = { WABHSR: "33AAGCS8525B1ZL", WABRTK: "06AAGCS8525B1ZI" };
const MOCK_TOKEN = "mock-ecm-token";
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The billable receipts, by poKey. 1000001 and 1000004 are in the R-NOTE fixture (rnote-results-real.html); the others are added to the results. */
const BILLS = {
  1000001: {
    source: "RNOTE", invoiceNumber: "1331000901", scenario: "Normal stock bill, IGST, third-party inspection", expected: "No checks. The draft is created and the item saved. Documents include the IC.",
    rly: "11", rlyShort: "ECOR", railwayName: "East Coast Railway", poKey: "1000001", poNumber: "11260000100001", poDate: "01/07/2026", unit: "14651", nitOid: "100000001",
    payAuth: "A1001-11^^PFA/ECoR/BBS(A1001)-3101-ECOR", stockNonstock: "S", poSr: "001", plNo: "29160388", description: "KIT FOR DIST EQUIPMENT MANIFOLD ASSLY (MOCK)",
    deliveryDate: "19/10/2026", allocation: "20712804", qty: 87, rate: 7916, uom: "Set", unitCode: "03", gst: 18,
    consignee: "004800^^DLS/VSKP (Andhra Pradesh, GST# 37AAAGM0289C1ZI)", inspection: "TPI",
    roNo: "48300000001", roDate: "14/10/2026", drr: "RT000001", rNote: "4800000001", rNoteDate: "14/10/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/11/4800000001.pdf"
  },
  1000004: {
    source: "RNOTE", invoiceNumber: "1061000902", scenario: "Long place of supply, consignee inspection", expected: "A warning about shortening the place of supply must be ticked first. Documents include the E-Declaration.",
    rly: "05", rlyShort: "NFR", railwayName: "North East Frontier Railway", poKey: "1000004", poNumber: "05260000100004", poDate: "20/05/2026", unit: "18870", nitOid: "100000004",
    payAuth: "A3001-05^^DFM/GHY(A3001)-0519-NFR", stockNonstock: "S", poSr: "001", plNo: "335200790028", description: "CARBON STRIP FOR PANTOGRAPH (MOCK)",
    deliveryDate: "01/09/2026", allocation: "20712808", qty: 15, rate: 27445, uom: "Number", unitCode: "01", gst: 18,
    consignee: "35294^^SSE/C/IC/KYQ (Assam, GST# 18AAAGM0289C1ZI)", inspection: "CONSG",
    roNo: "44000000004", roDate: "04/09/2026", drr: "R0000004", rNote: "4400000004", rNoteDate: "04/09/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/05/4400000004.pdf"
  },
  1000005: {
    source: "RNOTE", invoiceNumber: "1331000905", scenario: "Same-state bill, CGST + SGST", expected: "No checks. The tax splits into CGST 9% + SGST 9% instead of IGST 18%.",
    rly: "06", rlyShort: "SR", railwayName: "Southern Railway", poKey: "1000005", poNumber: "06260000100005", poDate: "10/06/2026", unit: "16010", nitOid: "100000005",
    payAuth: "A0601-06^^PFA/SR/MAS(A0601)-0601-SR", stockNonstock: "S", poSr: "001", plNo: "29160999", description: "BRAKE CYLINDER REPAIR KIT (MOCK)",
    deliveryDate: "20/10/2026", allocation: "20712905", qty: 20, rate: 2983, uom: "Set", unitCode: "03", gst: 18,
    consignee: "33021^^SSE/CW/MAS (Tamil Nadu, GST# 33AAAGM0289C1ZQ)", inspection: "TPI",
    roNo: "33300000005", roDate: "12/10/2026", drr: "R3300005", rNote: "3300000005", rNoteDate: "12/10/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/06/3300000005.pdf"
  },
  1000006: {
    source: "CRN", invoiceNumber: "1061000906", scenario: "Non-stock bill through a CRN", expected: "No checks. Non-Stock, IGST, consignee inspection, with no R-Note or DRR number.",
    rly: "12", rlyShort: "NCR", railwayName: "North Central Railway", poKey: "1000006", poNumber: "12260000100006", poDate: "24/06/2026", unit: "14220", nitOid: "100000006",
    payAuth: "A3502-12^^WAO/JHS(A3502)-3207-NCR", stockNonstock: "N", poSr: "001", plNo: "29161234", description: "KIT FOR UNLOADER EXHAUST VALVE (MOCK)",
    deliveryDate: "15/10/2026", allocation: "20713006", qty: 100, rate: 2983, uom: "Set", unitCode: "03", gst: 18,
    consignee: "12345^^ETD/CNB (Uttar Pradesh, GST# 09AAAGM0289C1ZH)", inspection: "CONSG",
    roNo: "013809-26-20009", roDate: "06/10/2026", drr: "Not Applicable", rNote: "Not Applicable", rNoteDate: "Not Applicable", rnUrl: "/ireps/etender/ct/MMIS/CONS/2026/12/20009/013809-26-20009_1.pdf"
  },
  1000007: {
    source: "RNOTE", invoiceNumber: "1331000907", scenario: "Invoice amount does not match the receipt", expected: "Stopped at Prepare with an amount error. Nothing is written to IREPS.",
    rly: "13", rlyShort: "NWR", railwayName: "North Western Railway", poKey: "1000007", poNumber: "13260000100007", poDate: "02/07/2026", unit: "13110", nitOid: "100000007",
    payAuth: "A1301-13^^PFA/NWR/JP(A1301)-1301-NWR", stockNonstock: "S", poSr: "001", plNo: "29162000", description: "RELAY VALVE ASSEMBLY (MOCK)",
    deliveryDate: "11/10/2026", allocation: "20713107", qty: 10, rate: 1000, uom: "Nos.", unitCode: "01", gst: 18,
    consignee: "77001^^SSE/CW/SBC (Karnataka, GST# 29AAAGM0289C1ZF)", inspection: "TPI",
    roNo: "77700000007", roDate: "09/10/2026", drr: "R7700007", rNote: "7700000007", rNoteDate: "09/10/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/13/7700000007.pdf"
  },
  1000008: {
    source: "RNOTE", invoiceNumber: "1331000908", scenario: "Invoice has a bad HSN code", expected: "Known gap: Prepare passes and the draft IS created, then the item stops on the HSN. The draft stays behind.",
    rly: "04", rlyShort: "NER", railwayName: "North Eastern Railway", poKey: "1000008", poNumber: "04260000100008", poDate: "05/07/2026", unit: "12120", nitOid: "100000008",
    payAuth: "A0401-04^^PFA/NER/GKP(A0401)-0401-NER", stockNonstock: "S", poSr: "001", plNo: "29163000", description: "BRAKE PIPE HOSE ASSEMBLY (MOCK)",
    deliveryDate: "13/10/2026", allocation: "20713208", qty: 5, rate: 2000, uom: "Nos.", unitCode: "01", gst: 18,
    consignee: "88001^^SSE/CW/VSKP (Andhra Pradesh, GST# 37AAAGM0289C1ZI)", inspection: "TPI",
    roNo: "88800000008", roDate: "10/10/2026", drr: "R8800008", rNote: "8800000008", rNoteDate: "10/10/2026", rnUrl: "/ireps/etender/pdfdocs/MMIS/RN/2026/04/8800000008.pdf"
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
  },
  {
    invoiceNumber: "1331000905", salesInvoiceDate: "2026-10-05 00:00:00.000", onivla: 70398.8, quantity: 20, offeredQuantity: 20, rate: 2983, totalTaxValue: 10738.8,
    taxCode: "CGST+SGST", serviceAccountingCode: "86072100", customerPONumber: "06260000100005", customerPOSrNumber: "001", division: "WABHSR",
    gstinRecipient: "33AAAGM0289C1ZQ", supplyPlace: "MAS/CHENNAI", consigneeLocation: "CHENNAI", consigneeAddressLine4: "CHENNAI, TN, 600001, IN",
    partDescription: "BRAKE CYLINDER REPAIR KIT", "Sent to Doculink": ""
  },
  {
    invoiceNumber: "1061000906", salesInvoiceDate: "2026-09-28 00:00:00.000", onivla: 351994, quantity: 100, offeredQuantity: 100, rate: 2983, totalTaxValue: 53694,
    taxCode: "IGST", serviceAccountingCode: "84819090", customerPONumber: "12260000100006", customerPOSrNumber: "001", division: "WABRTK",
    gstinRecipient: "09AAAGM0289C1ZH", supplyPlace: "SMM/ETD /KANPUR", consigneeLocation: "KANPUR", consigneeAddressLine4: "KANPUR, UP, 208001, IN",
    partDescription: "KIT FOR UNLOADER EXHAUST VALVE", "Sent to Doculink": ""
  },
  {
    invoiceNumber: "1331000907", salesInvoiceDate: "2026-10-01 00:00:00.000", onivla: 12500, quantity: 10, offeredQuantity: 10, rate: 1000, totalTaxValue: 1800,
    taxCode: "IGST", serviceAccountingCode: "84818090", customerPONumber: "13260000100007", customerPOSrNumber: "001", division: "WABHSR",
    gstinRecipient: "29AAAGM0289C1ZF", supplyPlace: "SBC/BENGALURU", consigneeLocation: "BENGALURU", consigneeAddressLine4: "BENGALURU, KA, 560001, IN",
    partDescription: "RELAY VALVE ASSEMBLY", "Sent to Doculink": ""
  },
  {
    invoiceNumber: "1331000908", salesInvoiceDate: "2026-10-02 00:00:00.000", onivla: 11800, quantity: 5, offeredQuantity: 5, rate: 2000, totalTaxValue: 1800,
    taxCode: "IGST", serviceAccountingCode: "12", customerPONumber: "04260000100008", customerPOSrNumber: "001", division: "WABHSR",
    gstinRecipient: "37AAAGM0289C1ZI", supplyPlace: "VSKP", consigneeLocation: "VISAKHAPATNAM", consigneeAddressLine4: "VISAKHAPATNAM, AP, 530001, IN",
    partDescription: "BRAKE PIPE HOSE ASSEMBLY", "Sent to Doculink": ""
  }
];

/** Which document types the mock ECM holds per invoice (IC only for TPI bills, E-Dispatch Note only for CONSG ones). */
const ALWAYS = ["generatedMerge", "garrantyWarrantyCertificate", "modvatDeclarationCertificate", "workCertificate"];
const DOCUMENTS = {
  1331000901: ALWAYS,
  1061000902: [...ALWAYS, "eDispatchNote"],
  1331000905: ALWAYS,
  1061000906: [...ALWAYS, "eDispatchNote"],
  1331000907: ALWAYS,
  1331000908: ALWAYS,
  11260000100001: ["inspectionCertificate", "poCopy"],
  "05260000100004": ["poCopy"],
  "06260000100005": ["inspectionCertificate", "poCopy"],
  12260000100006: ["poCopy"],
  13260000100007: ["inspectionCertificate", "poCopy"],
  "04260000100008": ["inspectionCertificate", "poCopy"]
};

/** The documents a bill needs (the mock's own copy of the study's list, upload.md step 9). */
const BILL_DOCS = [
  { label: "Invoice", fileDesc: "INVOICE", when: "always" },
  { label: "GC/WC", fileDesc: "GUARANTEE WARRANTY CERTIFICATE", when: "always" },
  { label: "Modvat Declaration", fileDesc: "MODVAT DECLARATION", when: "always" },
  { label: "WTC", fileDesc: "WORK TEST CERTIFICATE", when: "always" },
  { label: "E-Declaration", fileDesc: "E INVOICING DECLARATION", when: "CONSG" },
  { label: "IC", fileDesc: "INSPECTION CERTIFICATE", when: "TPI" },
  { label: "DP/MA", fileDesc: "MODIFICATION ADVICE", when: "optional" },
  { label: "PO copy", fileDesc: "PURCHASE ORDER", when: "optional" }
];

const HEADER_FIELDS = [
  "invoiceAmount", "invoiceType", "payingRly", "stockNonstock", "fuelNonFuel", "multiInvoiceFlag", "invoiceCount", "billType", "spmBillRegNo", "organization",
  "department", "unit", "rly", "poKey", "poNumber", "poDate", "companyName", "pvc", "svcFlag", "gstFlag", "gstRegFlag", "reverseChargeFlag", "compositeFlag",
  "supplierGSTIN", "vendorCode", "payingAuthorityCode", "invoiceNo", "invoiceDate", "paymentType", "paymentPercent", "bankAccountNo", "ifscCode",
  "billDescription", "placeOfSupply", "stateOfSupply", "supplierState", "ipasAUCode", "nitOid", "supplementaryBillType", "paymentCode", "additionalPayment",
  "totalAmount", "rcvIdStr", "rcvRefundClaimAmtStr", "rrlNoStr", "rrlDateStr", "rrlValueStr", "totalBalanceAmtWraDouble"
];

const FIRST_BILL_REG_NO = 3900001;
const FIRST_DISPATCH_NO = 4900001;
let nextBillRegNo = FIRST_BILL_REG_NO;
let nextDispatchNo = FIRST_DISPATCH_NO;
let nextDocumentId = 1;
/** billRegNo -> { regNo, bill, header, item, dispatchNo, documents, status, createdBy, createdOn } */
const drafts = new Map();
const usedInvoices = new Set();

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const itemValue = (b) => round2(b.qty * b.rate + round2((b.qty * b.rate * b.gst) / 100));

function stamp() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

function draftFor(poKey) {
  for (const d of drafts.values()) if (d.bill.poKey === poKey) return d;
  return null;
}

function documentsText(d) {
  return `OK#${d.documents.length}<>${d.documents.map((x) => `${x.fileName}#${x.path}#${x.description}#${x.uploadedOn}#${x.uploadedBy}#${x.id}`).join("<>")}<>`;
}

/* -------------------------------------------------------------------------- */
/* Rows added to the search results                                           */
/* -------------------------------------------------------------------------- */

const EXTRA_BILLS = Object.values(BILLS).filter((b) => !["1000001", "1000004"].includes(b.poKey));

/** Filter data for the R-NOTE rows below, in the server's RNOTE_FIXTURE_DATA shape. */
export const EXTRA_RNOTE_DATA = EXTRA_BILLS.filter((b) => b.source === "RNOTE").map((b) => ({ poNo: b.poNumber, rly: b.rly, rnoteNo: b.rNote, crnDate: b.rNoteDate }));
/** Filter data for the CRN rows below, in the server's CRN_FIXTURE_DATA shape. */
export const EXTRA_CRN_DATA = EXTRA_BILLS.filter((b) => b.source === "CRN").map((b) => ({ poNo: b.poNumber, poDate: b.poDate, rly: b.rly, crnNo: b.roNo, crnDate: b.roDate }));
/** The POs for the PO search (screen 2), in the server's MOCK_PO_DB shape. */
export const BILL_POS = Object.values(BILLS).map((b) => ({ poNo: b.poNumber, poKey: b.poKey, rly: b.rly, unit: b.railwayName, poDate: b.poDate, stockType: b.stockNonstock === "N" ? "NS" : "S", poValue: String(itemValue(b)), folder: `2026/${b.rly}` }));

const claimLink = (b) => `<a href="#" onclick="postRequest('/epsn/ct/fetchPODetails.do?rly=${b.rly}&poKey=${b.poKey}')" title="Click Here to claim new Supplier Bill" ><img src="/ireps/images/common/vsin.jpg" alt="Claim Supplier Bill" height="15" width="15" border="0" class="linkStyle" /></a>`;
const managePo = (b) => `<a title="Manage Your Purchase Order" class="linkStyle" href="#" onclick="postRequest('/epsn/dispatchParticulars/showDispatchParticular.do?rly=${b.rly}&poKey=${b.poKey}&poNo=${b.poNumber}')" ><img src="/ireps/images/common/icon_view.gif" alt="Manage Your Purchase Order" height="15" width="15" border="0" class="linkStyle" /></a>`;

/** The added R-NOTE rows, in the captured layout. markDraftBills() then applies the bill state. */
export function extraRnoteRowsHtml() {
  return EXTRA_BILLS.filter((b) => b.source === "RNOTE").map((b, i) => {
    const pay = Array.from({ length: 11 }, () => '<td class="payDtlCls"></td>').join("");
    return `<tr style="line-height: 26px;" class="trPoRow">
<td class="searchDtlCls">${5 + i}</td><td class="searchDtlCls">${b.rlyShort}</td>
<td class="searchDtlCls"><a href="/ireps/etender/pdfdocs/MMIS/PO/2026/${b.rly}/${b.poNumber}.pdf" title="Click to View/Download PO" target="_blank">${b.poNumber}</a></td>
<td> ${b.poDate}</td><td class="searchDtlCls">${b.poSr}</td><td class="searchDtlCls">${b.rNote}</td><td class="searchDtlCls"> ${b.rNoteDate} </td><td class="searchDtlCls">${b.qty} ${b.uom}</td>
<td class="searchDtlCls">${b.roNo}</td><td class="searchDtlCls">${b.roDate}</td><td class="searchDtlCls">${b.drr}</td>
<td class="searchDtlCls">${claimLink(b)}</td>
<td class="payDtlCls"><a href="#" onclick="postRequestNewWindow('/epsn/ct/generateBillPreview.do?billRegNo=')" title="Click Here to View / Sign & Submit Draft Supplier Bill" ></a></td>
${pay}
<td class="dataText"><a title="View/Download RNOTE" class="linkStyle" href="${b.rnUrl}" target="_blank" ><img src="/ireps/images/common/View Negotiattion Details.png" alt="View/Download" height="15" width="15" border="0" class="linkStyle" /></a> ${managePo(b)}</td>
</tr>
`;
  }).join("");
}

/** The added CRN rows, in the captured layout, with the bill state applied. */
export function extraCrnRowsHtml() {
  return EXTRA_BILLS.filter((b) => b.source === "CRN").map((b, i) => {
    const d = draftFor(b.poKey);
    const claim = d ? d.status : claimLink(b);
    const bill = d
      ? `<a href="#" onclick="postRequestNewWindow('/epsn/ct/generateBillPreview.do?billRegNo=${d.regNo}')" title="Click Here to View / Sign & Submit Draft Supplier Bill" >${d.regNo}</a>`
      : `<a href="#" onclick="postRequestNewWindow('/epsn/ct/generateBillPreview.do?billRegNo=')" title="Click Here to View / Sign & Submit Draft Supplier Bill" ></a>`;
    const pd = (v) => `<td class="payDtlCls1">${v ?? ""}</td>`;
    return `
<tr>
<td>${9 + i}</td><td>${b.poNumber}</td><td>${b.poDate}</td><td>${b.invoiceNumber}</td><td>${b.roDate}</td><td><span style='color:blue;'>Fresh Supply</span><br></td><td>${b.rlyShort}</td><td>${b.poSr}</td>
<td><a href='${b.rnUrl}' target="_blank">${b.roNo}</a></td><td>${b.roDate}</td><td>${b.roDate}</td><td>${b.qty}</td>
<td class="searchDtlCls">${claim}</td>
<td class="payDtlCls1">${bill}</td>
${pd(d ? stamp().slice(0, 10) : "")}${pd(d ? d.header.invoiceNo : "")}${pd(d ? d.header.invoiceDate : "")}${pd("")}${pd("")}${pd("")}${pd("")}${pd(d && d.item ? d.item.totalAmount : "")}${pd("")}${pd("")}${pd("")}
<td>${managePo(b)}</td>
</tr>
`;
  }).join("");
}

/**
 * R-NOTE results: a receipt with a mock bill loses its Bill Claim link and shows the bill reg
 * no. in the Bill Reg No. cell, as the portal does. A submitted bill also shows "Signed".
 */
export function markDraftBills(rowsHtml) {
  return rowsHtml.replace(/<tr style="line-height: 26px;" class="trPoRow">[\s\S]*?<\/tr>/g, (row) => {
    const m = /fetchPODetails\.do\?rly=\d+&poKey=(\d+)/.exec(row);
    const draft = m ? draftFor(m[1]) : null;
    if (!draft) return row;
    return row
      .replace(/<a href="#" onclick="postRequest\('\/epsn\/ct\/fetchPODetails\.do[^"]*"[^>]*>[\s\S]*?<\/a>/, draft.status === "Signed" ? "Signed" : "")
      .replace(/generateBillPreview\.do\?billRegNo='\)" title="([^"]*)" >\s*<\/a>/, `generateBillPreview.do?billRegNo=${draft.regNo}')" title="$1" >${draft.regNo}</a>`);
  });
}

/* -------------------------------------------------------------------------- */
/* Field check: what IREPS received against what was expected                 */
/* -------------------------------------------------------------------------- */

const num = (v) => {
  const t = String(v ?? "").replace(/,/g, "").trim();
  return t !== "" && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

function isoToIreps(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** The expected values are worked out here from the mock's data, not with DocLink's code, so the check is independent. */
export function fieldCheck(d) {
  const { bill: b, header: h, item: i } = d;
  const inv = INVOICES.find((x) => x.invoiceNumber === h.invoiceNo) || null;
  const line = (label, field, received, expected, source, { numeric = false } = {}) => {
    const value = received ?? "";
    if (expected === null || expected === undefined) return { label, field, received: String(value), expected: null, source, result: "none" };
    const same = numeric && num(value) !== null && num(expected) !== null ? Math.abs(num(value) - num(expected)) < 0.005 : String(value).trim() === String(expected).trim();
    return { label, field, received: String(value), expected: String(expected), source, result: same ? "pass" : "fail" };
  };
  const fromInvoice = (v) => (inv ? v : null);

  const header = [
    line("Stock or Non-Stock", "stockNonstock", h.stockNonstock, b.stockNonstock, "The PO in IREPS"),
    line("Select Paying Railway", "payingRly", h.payingRly, b.rly, "The PO in IREPS"),
    line("Select Paying Authority", "payingAuthorityCode", h.payingAuthorityCode, b.payAuth.split("-")[0], "IREPS paying authority list"),
    line("Tax Invoice No.", "invoiceNo", h.invoiceNo, fromInvoice(inv?.invoiceNumber), "Invoice: invoiceNumber"),
    line("Tax Invoice Date", "invoiceDate", h.invoiceDate, fromInvoice(isoToIreps(inv?.salesInvoiceDate)), "Invoice: salesInvoiceDate, as dd/mm/yyyy"),
    line("Invoice Amount", "invoiceAmount", h.invoiceAmount, fromInvoice(inv?.onivla), "Invoice: onivla", { numeric: true }),
    line("Payment %", "paymentPercent", h.paymentPercent, "100", "Default: 100% final"),
    line("Payment Type", "paymentType", h.paymentType, "F", "Default: Final"),
    line("Bank Account No", "bankAccountNo", h.bankAccountNo, BANK, "Prefilled on the IREPS page"),
    line("IFSC Code", "ifscCode", h.ifscCode, IFSC, "Prefilled on the IREPS page"),
    line("Under Reverse Charge", "reverseChargeFlag", h.reverseChargeFlag, "N", "Constant"),
    line("Whether under composition scheme", "compositeFlag", h.compositeFlag, "N", "Constant"),
    line("Supplier GSTIN Registered", "gstRegFlag", h.gstRegFlag, "Y", "Constant"),
    line("Supplier GSTIN", "supplierGSTIN", h.supplierGSTIN, fromInvoice(GSTIN_BY_DIVISION[inv?.division]), "Invoice: division (rule still to be confirmed)"),
    line("Supplier State", "supplierState", h.supplierState, h.supplierGSTIN ? h.supplierGSTIN.slice(0, 2) : null, "First 2 digits of the supplier GSTIN"),
    line("State for Place of Supply", "stateOfSupply", h.stateOfSupply, fromInvoice(inv?.gstinRecipient?.slice(0, 2)), "Invoice: gstinRecipient (rule still to be confirmed)"),
    line("Place of Supply", "placeOfSupply", h.placeOfSupply, fromInvoice(inv?.supplyPlace?.slice(0, 20)), "Invoice: supplyPlace, at most 20 characters"),
    line("Bill Description(Remarks)", "billDescription", h.billDescription, fromInvoice(inv?.partDescription), "Invoice: partDescription")
  ];

  let item = [];
  if (i) {
    const taxable = round2(b.qty * b.rate);
    const tax = round2((taxable * b.gst) / 100);
    const interState = h.supplierState !== h.stateOfSupply;
    const half = round2(b.gst / 2);
    const gstin = /GST#\s*([0-9A-Z]{15})/.exec(b.consignee)[1];
    item = [
      line("Select PO Sr", "poSrNo", i.poSrNo, b.poSr, "The receipt in IREPS"),
      line("R-Note / RO No.", "roNo", i.roNo, b.roNo, "The receipt in IREPS"),
      line("RO Date", "roDate", i.roDate, b.roDate, "The receipt in IREPS"),
      line("RO/CRN Qty Billed", "roQtyBilled", i.roQtyBilled, b.qty, "The receipt in IREPS", { numeric: true }),
      line("DRR No.", "drrNumber", i.drrNumber, b.drr, "The receipt in IREPS"),
      line("R-Note No.", "rNoteNumber", i.rNoteNumber, b.rNote, "The receipt in IREPS"),
      line("RLY GSTIN", "rlyGSTIN", i.rlyGSTIN, gstin, "The consignee in IREPS"),
      line("Inspection Agency", "inspectionAgency", i.inspectionAgency, b.inspection, "The PO item in IREPS"),
      line("Basic PO Rate/Unit", "poRate", i.poRate, b.rate, "The PO item in IREPS", { numeric: true }),
      line("GST Category", "gstCategory", i.gstCategory, "0", "Default: Regular GST"),
      line("HSN Code", "hsnCode", i.hsnCode, fromInvoice(inv?.serviceAccountingCode), "Invoice: serviceAccountingCode"),
      line("ITC Admissible", "itcFlagFinal", i.itcFlagFinal, "N", "Constant"),
      line("IGST Rate(%)", "igstRate", i.igstRate, interState ? b.gst : 0, "PO GST rate, IGST when the states differ", { numeric: true }),
      line("CGST Rate(%)", "cgstRate", i.cgstRate, interState ? 0 : half, "Half the PO GST rate when the states match", { numeric: true }),
      line("SGST Rate(%)", "sgstRate", i.sgstRate, interState ? 0 : half, "Half the PO GST rate when the states match", { numeric: true }),
      line("IGST Amount", "igstAmount", i.igstAmount, interState ? tax : 0, "Taxable x rate", { numeric: true }),
      line("CGST Amount", "cgstAmount", i.cgstAmount, interState ? 0 : round2(tax / 2), "Taxable x rate", { numeric: true }),
      line("SGST Amount", "sgstAmount", i.sgstAmount, interState ? 0 : round2(tax / 2), "Taxable x rate", { numeric: true }),
      line("Taxable Amount", "expenseAmount", i.expenseAmount, taxable, "PO rate x quantity", { numeric: true }),
      line("Tax Amount", "basicAmount", i.basicAmount, tax, "Taxable x GST rate", { numeric: true }),
      line("Item-wise claim by vendor", "totalAmount", i.totalAmount, round2(taxable + tax), "Taxable + tax", { numeric: true }),
      line("Max Claim", "maxClaim", i.maxClaim, itemValue(b), "The receipt's value in IREPS", { numeric: true })
    ];
  }

  const all = [...header, ...item];
  const agency = i ? i.inspectionAgency : b.inspection;
  const documents = BILL_DOCS.map((x) => {
    // the study's rule: IC only for TPI; E-Declaration for CONSG, though a real TPI bill carried one too (upload.md step 9)
    const need = x.when === "always" || x.when === agency ? "Yes" : x.when === "TPI" ? "No" : "If applicable";
    const attached = d.documents.find((doc) => doc.description.trim().toUpperCase() === x.fileDesc);
    return { label: x.label, fileDesc: x.fileDesc, need, attached: attached ? attached.fileName : null };
  });
  return {
    billRegNo: d.regNo,
    createdBy: d.createdBy,
    reference: Boolean(inv),
    header,
    item,
    documents,
    summary: { checked: all.filter((c) => c.result !== "none").length, passed: all.filter((c) => c.result === "pass").length, failed: all.filter((c) => c.result === "fail").length, noReference: all.filter((c) => c.result === "none").length }
  };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

const fail = (text) => text;

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

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

  /* ------------------------------------------------------------- Mock only */
  if (path === "/mock/bill" || path === "/mock/bill/") return text(200, hubPage(Object.values(BILLS), draftFor));
  if (path === "/mock/bill/invoices.json") {
    return json(200, { _about: "Mock invoices for DocLink's 'From a JSON file' option. They match the receipts on /mock/bill/.", invoices: INVOICES });
  }
  if (path === "/mock/bill/reset" && req.method === "POST") {
    drafts.clear();
    usedInvoices.clear();
    nextBillRegNo = FIRST_BILL_REG_NO;
    nextDispatchNo = FIRST_DISPATCH_NO;
    nextDocumentId = 1;
    console.log("[mock-ireps] all mock bills deleted");
    res.writeHead(302, { Location: "/mock/bill/" });
    res.end();
    return true;
  }
  if (path === "/mock/bill/check" || path === "/mock/bill/check.json") {
    const d = drafts.get(url.searchParams.get("billRegNo"));
    if (path.endsWith(".json")) return d ? json(200, fieldCheck(d)) : json(404, { message: "No such mock bill" });
    return d ? text(200, checkPage(d, fieldCheck(d))) : text(404, `<p>No such mock bill. <a href="/mock/bill/">Back to the test hub</a></p>`);
  }
  // the Bill Claim icon: the real image isn't kept with the mock
  if (path === "/ireps/images/common/vsin.jpg") {
    return text(200, `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"><rect width="15" height="15" fill="#3b3f8f"/><rect x="3" y="3" width="9" height="9" fill="#9fa3e0"/></svg>`, "image/svg+xml");
  }

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

  /* ------------------------------------------------------------- Document file */
  if (path === "/cgi-bin/save.php") {
    if (req.method !== "POST") return text(405, "POST only");
    if (!h.hasSession(req)) return text(200, h.pages.login);
    const raw = await readRaw(req);
    const body = raw.toString("latin1");
    const field = (name) => (new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body) || [])[1] || "";
    if (raw.length >= MAX_FILE_BYTES) return text(200, "<html><body>Please upload file below 8 MB in size</body></html>");
    const dir = field("relative_dir");
    const name = field("pdfName");
    if (!name || !dir) return text(200, "<html><body>File not received</body></html>");
    console.log(`[mock-ireps] save.php ${name} (${raw.length} bytes, not kept)`);
    return text(200, `<html><body onload='window.parent.CRISPKI && window.parent.CRISPKI.afterUpload()'>OK~${dir}/${name}~${raw.length}</body></html>`);
  }

  /* ------------------------------------------------------------- IREPS */
  const billPaths = ["/epsn/ct/fetchPODetails.do", "/epsn/ct/populatePayAuthList.do", "/epsn/ct/populatePOSrList.do", "/epsn/common/getAjaxData.do", "/epsn/ct/saveBillHeader.do",
    "/epsn/ct/fetchPOItemDetails.do", "/epsn/ct/populateROList.do", "/epsn/ct/populateRODetails.do", "/epsn/ct/saveBillDetails.do", "/epsn/ct/generateBillPreview.do",
    "/epsn/ct/uploadBillDocuments.do", "/epsn/ct/deleteBillDocument.do", "/epsn/ct/generatePDF.do", "/epsn/supply/ct/showReceiptNotes.do", "/epsn/ct/showSubmittedBills.do", "/epsn/dispatchParticulars/showDispatchParticular.do"];
  if (!billPaths.includes(path)) return false;

  // the PO link of every other mock PO is not part of this flow
  if (path === "/epsn/dispatchParticulars/showDispatchParticular.do") {
    const query = req.method === "POST" ? await h.readBody(req) : url.search.slice(1);
    const key = new URLSearchParams(query).get("poKey");
    if (!BILLS[key]) return text(404, "<html><body><h1>HTTP Status 404 - Not mocked</h1><p>Only the POs on /mock/bill/ have this page.</p></body></html>");
    if (!h.hasSession(req)) return text(200, h.pages.login);
    return text(200, receiptNotesPage(BILLS[key], draftFor(key), USER));
  }

  const body = req.method === "POST" ? await h.readBody(req) : "";
  const form = new URLSearchParams(body);
  for (const [k, v] of url.searchParams) if (!form.has(k)) form.set(k, v);
  console.log(`[mock-ireps] ${req.method} ${path.split("/").pop()}  ${Array.from(form.keys()).length} fields  cookie=${h.hasSession(req) ? "yes" : "no"}`);
  if (!h.hasSession(req) || ["login", "expired"].includes(h.scenario())) return text(200, h.pages.login);
  if (h.scenario() === "http500") return text(500, "<html><body><h1>HTTP Status 500 - Internal Server Error</h1></body></html>");

  const bill = BILLS[form.get("poKey")] || Object.values(BILLS).find((b) => b.poNumber === form.get("poNumber"));
  const draftOf = () => drafts.get(form.get("billRegNo"));

  if (path === "/epsn/ct/fetchPODetails.do") {
    if (!bill) return text(200, "<html><body><span class='errorStyle'>No Purchase Order found for this claim.</span></body></html>");
    const d = draftOf() && draftOf().bill.poKey === bill.poKey ? draftOf() : null;
    return text(200, billEntryPage(bill, { vendor: VENDOR, companyName: COMPANY, vendorAddress: VENDOR_ADDRESS, supplierGstins: Object.keys(SUPPLIER_GSTINS), bank: BANK, ifsc: IFSC, user: USER, draft: d, check: d ? fieldCheck(d) : null }));
  }
  if (path === "/epsn/common/getAjaxData.do") {
    const gstin = form.get("gstNo") || "";
    return text(200, SUPPLIER_GSTINS[gstin] ? `${SUPPLIER_GSTINS[gstin]}^false^Valid GSTIN^${gstin}^${COMPANY}^^^^^^Y^Jun 8, 2021 12:00:00 PM^GSTIN Found in Local DB^Regular` : `0:^Invalid GSTIN^${gstin}`);
  }
  if (path === "/epsn/ct/generateBillPreview.do") {
    const d = draftOf();
    return text(200, d ? previewPage(d, USER) : "<html><body>No draft bill.</body></html>");
  }
  if (path === "/epsn/ct/generatePDF.do") {
    const d = draftOf();
    if (!d) return text(200, "<html><body>No draft bill.</body></html>");
    if (d.item) {
      d.status = "Signed";
      console.log(`[mock-ireps] bill ${d.regNo} submitted (simulated signature)`);
    }
    return text(200, previewPage(d, USER));
  }
  if (path === "/epsn/ct/uploadBillDocuments.do") {
    const d = draftOf();
    if (!d) return text(200, fail("Invalid Bill Reg No."));
    if (!(form.get("fileDesc") || "").trim()) return text(200, fail("Please enter the Description of the document!"));
    d.documents.push({ fileName: form.get("fileName"), path: form.get("filePath"), description: form.get("fileDesc").trim(), uploadedOn: stamp(), uploadedBy: "MOCK USER", id: String(nextDocumentId++) });
    return text(200, documentsText(d));
  }
  if (path === "/epsn/ct/deleteBillDocument.do") {
    const d = draftOf();
    if (!d) return text(200, fail("Invalid Bill Reg No."));
    d.documents = d.documents.filter((x) => x.id !== form.get("id") || /SYSTEM UPLOAD/.test(x.description));
    return text(200, documentsText(d));
  }
  if (!bill) return text(200, fail("No PO details found."));

  switch (path) {
    case "/epsn/supply/ct/showReceiptNotes.do":
      return text(200, receiptNotesPage(bill, draftFor(bill.poKey), USER));
    case "/epsn/ct/showSubmittedBills.do":
      return text(200, submittedBillsPage(bill, draftFor(bill.poKey), USER));
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
      const createdBy = req.headers["x-mock-screen"] ? "mock screen" : "DocLink";
      drafts.set(regNo, { regNo, bill, header: Object.fromEntries(form), item: null, dispatchNo: null, documents: [], status: "Draft", createdBy, createdOn: stamp(), itemValue: itemValue(bill) });
      console.log(`[mock-ireps] draft bill ${regNo} created for PO ${bill.poNumber} / invoice ${form.get("invoiceNo")} (${createdBy})`);
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
      const breakup = bill.source === "CRN" ? "NA" : ` ${bill.rNote}:${bill.qty}`;
      return text(200, `success^^${bill.roDate}^^${bill.qty}^^${bill.drr}^^0^^${bill.rNote}^^${bill.rNoteDate}^^0^^${breakup}^^^^${bill.qty}.0^^^^${value}^^0^^${value}^^http://www.ireps.gov.in${bill.rnUrl}`);
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
      d.item = Object.fromEntries(form);
      d.documents = [{ fileName: `${bill.roNo}.pdf`, path: bill.rnUrl.slice(1), description: "RNOTE / CRN - SYSTEM UPLOAD", uploadedOn: stamp(), uploadedBy: "MOCK USER", id: String(nextDocumentId++) }];
      console.log(`[mock-ireps] item saved on bill ${form.get("billRegNo")} (dispatch ${d.dispatchNo}, claim ${claim})`);
      return text(200, `success^^${d.dispatchNo}^^${claim}^^${form.get("rlyGSTIN")}^^${documentsText(d)}`);
    }
    default:
      return false;
  }
}

/** Link text for the control panel. */
export const BILL_HUB_LINK = `<a href="/mock/bill/">${esc("Bill upload test hub")}</a>`;
