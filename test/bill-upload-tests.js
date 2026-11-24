/**
 * Tests for the bill upload (services/bill-upload/, upload.md): the R-NOTE / CRN Bill Claim
 * links, the bill page reader, the IREPS response parsers, the header / item rules on the
 * captured bills, the ECM invoice lookup and document fetch, and the whole flow against a
 * fake IREPS (writes only after confirmation, never twice for one receipt, stops on checks).
 * No extension APIs are used. Invoked from run-tests.js.
 *
 * Captured values used as test vectors (upload.md): the non-stock bill (PO 40265077101806,
 * CRN 35294-26-66158, HAR #369-#373), the stock bill (HAR #109-#117) and screenshot bill
 * 100 x 2983 at 18 %.
 */

import { parseRnoteSearchResults, matchRnoteHeader } from "../services/rnote/rnote-parser.js";
import { parseCrnSearchResults } from "../services/crn/crn-parser.js";
import {
  BILL_ERROR,
  SAVE_HEADER_FIELDS,
  SAVE_DETAILS_FIELDS,
  orderedBody,
  parsePayAuthList,
  parsePoSrList,
  parseGstinStatus,
  parseSaveHeader,
  parseItemDetails,
  parseRoList,
  parseRoDetails,
  parseSaveDetails,
  successFields,
  missingAnswerReason,
  RO_REFUSALS
} from "../services/bill-upload/bill-upload-api.js";
import { parseBillForm, hasBillForm } from "../services/bill-upload/bill-form.js";
import {
  buildHeader,
  buildItem,
  computeAmounts,
  gstSplit,
  invoiceDateToIreps,
  invoiceDateRefusal,
  pageRound2,
  round2,
  stateCodeOf,
  deriveStateOfSupply,
  deriveSupplierGstin,
  paymentPercentFrom,
  precheckReceipt,
  hsnCheck,
  railwayGstinFor
} from "../services/bill-upload/bill-rules.js";
import { normaliseInvoice, invoiceRecords, retrieveInvoice, manualInvoice, isSentToDoculink, billDocumentsQuery, receiptMismatches, BILL_DOCUMENTS, MAX_DOCUMENT_BYTES } from "../services/bill-upload/ecm-invoice.js";
import { createBillStore, memoryStorageArea } from "../services/bill-upload/bill-upload-store.js";
import { parseInvoiceFile, invoiceFromFile, receiptInvoiceKey, MAX_INVOICE_FILE_BYTES } from "../services/bill-upload/invoice-file.js";
import {
  receiptFromRnote,
  receiptFromCrn,
  findBillableReceipts,
  invoiceForReceipt,
  prepareBill,
  reviewBill,
  createDraftBill,
  forgetBill,
  saveItem,
  addDocumentToBill,
  confirmCheckedInIreps,
  unknownOutcome,
  collectBillDocuments,
  documentNeed
} from "../services/bill-upload/bill-upload-service.js";
import { tabFetch, tabSaveFile } from "../services/bill-upload/tab-transport.js";
import { finishSteps, startFreshText, initBillUpload, handleBillUploadMessage } from "../popup/popup-bill-upload.js";
import { createBillUploadJob } from "../background/bill-upload-job.js";
import { withIrepsFormLock } from "../services/ireps-form-lock.js";
import { callEcmAutomation, resetEcmDirectState } from "../services/ecm-direct.js";
import { applyEcmConfig } from "../services/ecm-config.js";
import { IrepsError, IREPS_ERROR, IREPS_CONFIG, loadIrepsConfig, requestIreps } from "../services/ireps-api.js";
import { describeError, ERROR_CATALOG, MESSAGE_TYPES, SESSION_KEYS } from "../utils/messages.js";
import {
  signerRequest,
  signerFrames,
  parseSignerReply,
  parseSaveResult,
  irepsFileName,
  billDocumentsDir,
  uploadBillDocument,
  UPLOAD_DOCUMENT_FIELDS
} from "../services/bill-upload/bill-document-upload.js";

/* -------------------------------------------------------- captured vectors */

const NS = {
  payAuth: "success^^A3001-05^^DFM/GHY(A3001)-0519-NFR",
  poSr: "success^^001",
  gstin: "1013:Haryana^false^Valid GSTIN^06AAGCS8525B1ZI^SAMPLE SUPPLIER PVT LTD^^^^^^Y^Jun 8, 2021 12:00:00 PM^GSTIN Found in Local DB:Old API^Regular",
  item: "success@#$%001^^335200790028^^Carbon strip for pantograph (test description)^^01/09/2026^^20712808^^15^^27445^^Number^^01^^1@#$%%^^-1^^-1^^U^^-1^^%^^-1^^-1@#$%0^^0^^0^^0^^0^^18^^0^^0@#$%NA^^NA@#$%0^^35294^^SSE/C/IC/KYQ (Assam, GST# 18AAAGM0289C1ZI)^^null^^null^^null@#$%CONSG@#$%NA@#$%disabled",
  roList: "success^^1^^35294-26-66158",
  ro: "success^^04/09/2026^^15^^Not Applicable^^0^^Not Applicable^^Not Applicable^^0^^NA^^^^15.0^^^^485776.5^^0^^485776.5^^http://www.ireps.gov.in/ireps/etender/ct/MMIS/CONS/2026/05/643141/35294-26-66158_1.pdf",
  saveDetails: "success^^3894570^^485776.5^^18AAAGM0289C1ZI^^OK#1<>35294-26-66158.pdf#ireps/etender/ct/MMIS/CONS/2026/05/643141/35294-26-66158_1.pdf#RNOTE / CRN - SYSTEM UPLOAD#15/09/2026 16:39#SAMPLE USER#16873771<>"
};

/** The non-stock bill's saveBillDetails.do request (#373) - the values buildItem must reproduce. */
const NS_DETAILS =
  "billType=S&gstFlag=Y&rly=05&poKey=6710723&poNumber=40265077101806&poDate=20%2F05%2F2026&pvc=Not+Applicable&billRegNo=3744921&paymentType=F&poSrNo=001&invoiceNo=1061000262&invoiceDate=08%2F08%2F2026&billItemSrNo=1&plNo=335200790028&description=Carbon+strip+for+pantograph+%28test+description%29&consigneeCode=35294&unitCode=01&deliveryDate=01%2F09%2F2026&allocation=20712808&qtyOrdered=15&poRate=27445&paymentPercent=100&dispatchNo=0&pvcOnPoRate=0&dispatchMode=NA&rrNumber=0&rrDate=0&rrQuantity=0&icNumber=&icDate=&icPassedQuantity=&icPreviouslyBilledQuantity=&icBalanceQuantity=&icQuantityNowBilled=&disUnit=%25&disRate=0&disAmt=0.00&pkgUnit=-1&pkgRate=0&pkgAmt=0.00&edUnit=-1&edRate=0&edAmt=0.00&stUnit=%25&stRate=18&fwdUnit=-1&fwdRate=0&frtUnit=U&frtRate=0&oth1Unit=-1&oth2Unit=-1&oth1Rate=0&oth2Rate=0&fwdAmt=0.00&frtAmt=0.00&oth1Amt=0.00&oth2Amt=0.00&stAmt=0.00&oth1Des=NA&oth2Des=NA&netBasicRate=27445&expenseAmount=411675.00&basicAmount=74101.50&totalAmount=485776.50&amountClaimed=0&gstCategory=0&itcFlagRail=N&hsnCode=85452000&cessRate=0&igstRate=18&cgstRate=0&sgstRate=0&utgstRate=0&igstAmount=74101.5&cgstAmount=0&sgstAmount=0&utgstAmount=0&cessAmount=0&challanNumber=0&challanDate=0&drrNumber=Not+Applicable&drrDate=0&drrQuantity=0&itcFlagRoad=N&itcFlagFinal=N&roNo=35294-26-66158&roDate=04%2F09%2F2026&roQty=15&roQtyBilled=15&itc=0&addExpStr=&compositeFlag=N&inspectionAgency=CONSG&rlyGSTIN=18AAAGM0289C1ZI&spmBillRegNo=null&vendorRemarks=&grossAmt=&passedAmount=0&balanceAmt=&additionalPayment=0&maxClaim=485776.5&rNoteNumber=Not+Applicable&rNoteDate=Not+Applicable&deliveryChallanNo=&deliveryChallanDate=&fuelNonFuel=N&rnUrl=http%3A%2F%2Fwww.ireps.gov.in%2Fireps%2Fetender%2Fct%2FMMIS%2FCONS%2F2026%2F05%2F643141%2F35294-26-66158_1.pdf";

/** Header values as saved for the non-stock bill (#369); bank details and company name fictitious. */
const NS_HEADER = {
  invoiceAmount: "485777", invoiceType: "I", payingRly: "05", stockNonstock: "N", fuelNonFuel: "N", multiInvoiceFlag: "N", invoiceCount: "1", billType: "S",
  spmBillRegNo: "null", organization: "01", department: "19", unit: "18870", rly: "05", poKey: "6710723", poNumber: "40265077101806", poDate: "20/05/2026",
  companyName: "SAMPLE", pvc: "N", svcFlag: "Y", gstFlag: "Y", gstRegFlag: "Y", reverseChargeFlag: "N", compositeFlag: "N", supplierGSTIN: "06AAGCS8525B1ZI",
  vendorCode: ":833", payingAuthorityCode: "A3001", invoiceNo: "1061000262", invoiceDate: "08/08/2026", paymentType: "F", paymentPercent: "100",
  bankAccountNo: "000111222333", ifscCode: "TEST0000001", billDescription: "CLAIM FOR 100% PAYMENT", placeOfSupply: "coaching Depot/Guwah", stateOfSupply: "18", supplierState: "06", ipasAUCode: "0519",
  nitOid: "107052246", supplementaryBillType: "", paymentCode: "000000", additionalPayment: "", totalAmount: "", rcvIdStr: "", rcvRefundClaimAmtStr: "",
  rrlNoStr: "", rrlDateStr: "", rrlValueStr: "", totalBalanceAmtWraDouble: "0"
};

/** The fixture bill page for one PO. */
async function billPage(fixture, values = {}) {
  const v = { rly: "05", poKey: "6710723", poNumber: "40265077101806", poDate: "20/05/2026", unit: "18870", nitOid: "107052246", vendor: "833", companyName: "SAMPLE RAIL SUPPLIES PVT LTD-UNIT A", railwayName: "North East Frontier Railway", ...values };
  return (await fixture("bill-form-page.html")).replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? "");
}

const CRN_RECEIPT_RECORD = {
  poNo: "40265077101806", poDate: "20/05/2026", challanNo: "1061000262", poSerial: "001", crnNo: "35294-26-66158", crnDate: "04/09/2026", crnQty: "15",
  billClaimStatus: null, billClaim: { rly: "05", poKey: "6710723" }, billRegNo: null, railway: "NFR"
};

const ECM_INVOICE = {
  invoiceNumber: "1061000262", invoiceDate: "2026-08-08 00:00:00.000", amount: 485776.5, quantity: "15", hsn: "85452000", division: "WABRTK",
  gstinRecipient: "18AAAGM0289C1ZI", supplyPlace: "coaching Depot/Guwahati", taxCode: "IGST", source: "ECM"
};

/**
 * A fake IREPS answering the bill endpoints with the captured non-stock answers; records
 * every call. `override(path, body)` may answer a call itself: a text (HTTP 200), a Response, or
 * an Error the transport throws (the answer never arrives).
 */
function fakeBillIreps(page, { override, billRegNo = "3744921" } = {}) {
  const calls = [];
  const answer = (text) => new Response(text, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body == null ? "" : String(init.body);
    calls.push({ path, body, headers: init.headers || {} });
    const own = override && override(path, body);
    if (own instanceof Error || (typeof DOMException !== "undefined" && own instanceof DOMException)) throw own;
    if (own instanceof Response) return own;
    if (own !== undefined && own !== null) return answer(own);
    switch (path) {
      case "/epsn/ct/fetchPODetails.do": return answer(page);
      case "/epsn/ct/populatePayAuthList.do": return answer(NS.payAuth);
      case "/epsn/ct/populatePOSrList.do": return answer(new URLSearchParams(body).get("stockNonstock") === "N" ? NS.poSr : "success");
      case "/epsn/common/getAjaxData.do": return answer(NS.gstin);
      case "/epsn/ct/saveBillHeader.do": return answer(`success^^${billRegNo}`);
      case "/epsn/ct/fetchPOItemDetails.do": return answer(NS.item);
      case "/epsn/ct/populateROList.do": return answer(NS.roList);
      case "/epsn/ct/populateRODetails.do": return answer(NS.ro);
      case "/epsn/ct/saveBillDetails.do": return answer(NS.saveDetails);
      default: return new Response("not found", { status: 404 });
    }
  };
  return { fetchImpl, calls, writes: () => calls.filter((c) => /saveBill(Header|Details)/.test(c.path)) };
}

/** What the tab transport throws when the IREPS tab was reloaded, closed or left mid-request. */
const CHANNEL_CLOSED = "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received";
const tabGone = () => Object.assign(new TypeError(`the IREPS tab could not run the request: ${CHANNEL_CLOSED}`), { tabTransport: "tab" });

/** Wait (a macrotask at a time) until `ready()` holds; fails after `tries` turns. */
async function until(ready, what, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The error a promise rejects with (null when it resolves). */
async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

export async function runBillUploadTests({ test, assert, eq, rejects, fixture }) {
  await loadIrepsConfig();
  const TODAY = new Date(Date.UTC(2026, 9, 26));

  /* ------------------------------------------------------- receipts */

  await test("bill upload: R-NOTE headers of the captured layout (RNOTE Qty is the quantity, never the number)", () => {
    eq(matchRnoteHeader("RNOTE Qty"), "quantity");
    eq(matchRnoteHeader("RNOTE No."), "rnoteNo");
    eq(matchRnoteHeader("RNOTE Date"), "rnoteDate");
    eq(matchRnoteHeader("RO No."), "roNo");
    eq(matchRnoteHeader("RO Date"), "roDate");
    eq(matchRnoteHeader("DRR No."), "drrNo");
    eq(matchRnoteHeader("Bill Claim"), "billClaimStatus");
    eq(matchRnoteHeader("Bill Reg No."), "billRegNo");
    eq(matchRnoteHeader("PO_SR"), "poSerial");
  });

  await test("bill upload: real R-NOTE layout -> Bill Claim (rly, poKey), RO / DRR, quantity, existing draft bill", async () => {
    const result = parseRnoteSearchResults(await fixture("rnote-results-real.html"));
    eq(result.records.length, 4, "rows");
    const [r1, r2, r3, r4] = result.records;
    eq(r1.rnoteNo, "4800000001");
    eq(r1.quantity, "87 Set");
    eq(r1.roNo, "48300000001");
    eq(r1.drrNo, "RT000001");
    eq(r1.poSerial, "001");
    eq(JSON.stringify(r1.billClaim), JSON.stringify({ rly: "11", poKey: "1000001" }));
    eq(r1.billRegNo, null, "empty draft link = no bill");
    assert(/\/MMIS\/RN\/2026\/11\/4800000001\.pdf$/.test(r1.documentUrl), "R-Note PDF link from the Action cell");
    eq(r2.billClaim, null);
    eq(r2.billClaimStatus, "Rnote Not Published");
    eq(r3.billClaim, null);
    eq(r3.billRegNo, "3999001");
    eq(JSON.stringify(r4.billClaim), JSON.stringify({ rly: "05", poKey: "1000004" }));

    const receipts = result.records.map(receiptFromRnote);
    eq(receipts[0].billable, true);
    eq(receipts[0].qty, 87);
    eq(receipts[0].key, "RNOTE|11|1000001|11260000100001|001|48300000001");
    eq(receipts[1].billable, false);
    eq(receipts[1].reason, "Rnote Not Published");
    eq(receipts[2].billable, false);
    assert(/already shows bill 3999001/.test(receipts[2].reason), receipts[2].reason);
  });

  await test("bill upload: CRN rows keep the Bill Claim link; a returned bill can be claimed again", () => {
    const html = `<table id="dTbl"><thead><tr><th>#</th><th>PO No.</th><th>PO Date</th><th>Challan No.</th><th>Challan Date</th><th>CRN Type<br>Claim No.</th><th>Rly</th><th>PO Sr</th><th>CRN No.</th><th>CRN date</th><th>Approval Date</th><th>CRN Qty</th><th>Bill Claim</th><th>Bill Reg No.</th></tr></thead>
      <tbody><tr><td>1</td><td>62265025100089</td><td>15/04/2026</td><td>1331000521</td><td>12/08/2026</td><td><span>Fresh Supply</span><br></td><td>NCR</td><td>001</td>
      <td><a href='/ireps/etender/ct/MMIS/CONS/2026/12/506755/032098-26-10608_1.pdf'>032098-26-10608</a></td><td>30/08/2026</td><td>11/09/2026</td><td>46</td>
      <td class="searchDtlCls"> Returned <a href="#" onclick="postRequest('/epsn/ct/fetchPODetails.do?rly=12&amp;poKey=6674952')" title="Click Here to claim new Supplier Bill"><img></a></td>
      <td><a href="http://www.ireps.gov.in/ireps/etender/ct/sbill/082026/SAMPLE_833_3738579.pdf"> 3738579</a></td></tr></tbody></table>`;
    const [record] = parseCrnSearchResults(html).records;
    eq(JSON.stringify(record.billClaim), JSON.stringify({ rly: "12", poKey: "6674952" }));
    eq(record.billClaimStatus, "Returned");
    const receipt = receiptFromCrn(record);
    eq(receipt.billable, true);
    eq(receipt.roNo, "032098-26-10608", "IREPS lists the CRN as the RO");
    assert(/returned/.test(receipt.reason), receipt.reason);
  });

  await test("bill upload: findBillableReceipts runs R-NOTE and CRN by PO number; a 'not found' side is no error", async () => {
    const seen = [];
    const rnote = parseRnoteSearchResults(await fixture("rnote-results-real.html"));
    const found = await findBillableReceipts(
      { poNo: " 11260000100001 " },
      {
        searchRnote: async (o) => (seen.push(["RNOTE", o]), rnote),
        searchCrn: async (o) => {
          seen.push(["CRN", o]);
          throw new IrepsError("IREPS_CRN_NOT_FOUND", "none");
        }
      }
    );
    eq(seen.length, 2);
    eq(seen[0][1].mode, "poNumber");
    eq(seen[0][1].poNo, "11260000100001");
    eq(found.receipts.length, 4);
    eq(found.receipts[0].billable, true, "billable first");
    eq(found.warnings.length, 0);
    await rejects(findBillableReceipts({}, { searchRnote: async () => ({ records: [] }), searchCrn: async () => ({ records: [] }) }), BILL_ERROR.NO_RECEIPTS);
  });

  /* ------------------------------------------------------- page + responses */

  await test("bill upload: bill page -> script literals, company, bank, GSTIN / railway / state options", async () => {
    const html = await billPage(fixture);
    assert(hasBillForm(html), "recognised");
    const form = parseBillForm(html);
    eq(form.missing.length, 0, `missing ${form.missing}`);
    eq(form.literals.unit, "18870");
    eq(form.literals.poKey, "6710723");
    eq(form.literals.nitOid, "107052246");
    eq(form.literals.vendorCode, ":833");
    eq(form.literals.paymentCode, "000000");
    eq(form.companyName, "SAMPLE RAIL SUPPLIES PVT LTD-UNIT A");
    eq(form.bankAccountNo, "000111222333");
    eq(form.ifscCode, "TEST0000001");
    eq(form.supplierGstins.map((o) => o.value).join(","), "06AAGCS8525B1ZI,02AAGCS8525B1ZQ,33AAGCS8525B1ZL");
    eq(form.payingRailways.length, 1);
    eq(form.payingRailways[0].selected, true);
    assert(form.railwayGstins.some((o) => o.value === "18AAAGM0289C1ZI"));
    eq(form.states.find((o) => o.value === "18").label, "Assam");
    eq(form.paymentTerms.finalPercent, 0);
    assert(!hasBillForm(await fixture("login-page.html")), "login page is not the bill page");
  });

  await test("bill upload: IREPS bill responses (^^ and @#$% formats) parse; anything else is a refusal", () => {
    const [auth] = parsePayAuthList(NS.payAuth);
    eq(auth.code, "A3001");
    eq(auth.ipasAUCode, "0519");
    eq(parsePoSrList(NS.poSr).join(), "001");
    const gst = parseGstinStatus(NS.gstin);
    eq(gst.valid, true);
    eq(gst.stateName, "Haryana");
    eq(parseGstinStatus("1013:Haryana^false^Inactive^06X^^^^^^^N").valid, false);
    eq(parseSaveHeader("success^^3816672").billRegNo, "3816672");
    const item = parseItemDetails(NS.item);
    eq(item.poRate, "27445");
    eq(item.rates.st, "18");
    eq(item.units.frt, "U");
    eq(item.units.fwd, "-1");
    eq(item.consigneeCode, "35294");
    eq(item.consigneeGstin, "18AAAGM0289C1ZI");
    eq(item.consigneeState, "Assam");
    eq(item.inspectionAgency, "CONSG");
    eq(parseRoList(NS.roList).join(), "35294-26-66158");
    const ro = parseRoDetails(NS.ro);
    eq(ro.roQty, "15");
    eq(ro.itemValue, "485776.5");
    eq(ro.maxClaim, "485776.5");
    eq(ro.rNoteNumber, "Not Applicable");
    const stock = parseRoDetails("success^^14/10/2026^^87^^RT260464^^0^^4826100504^^14/10/2026^^0^^ 4826100504:87^^^^87.0^^^^812656.56^^0^^812656.56^^http://www.ireps.gov.in/ireps/etender/pdfdocs/MMIS/RN/2026/11/4826100504.pdf");
    eq(stock.drrNumber, "RT260464");
    eq(stock.rNoteNumber, "4826100504");
    eq(stock.billableQty, "87.0");
    const saved = parseSaveDetails(NS.saveDetails);
    eq(saved.dispatchNo, "3894570");
    eq(saved.rlyGSTIN, "18AAAGM0289C1ZI");
    eq(saved.documents[0].description, "RNOTE / CRN - SYSTEM UPLOAD");
    let refused = null;
    try {
      successFields("saveBillHeader", "Duplicate invoice number for this vendor");
    } catch (error) {
      refused = error;
    }
    eq(refused && refused.code, BILL_ERROR.IREPS_REJECTED);
    assert(/Duplicate invoice/.test(refused.detail), refused && refused.detail);
  });

  await test("bill upload: request bodies keep the captured field order; a missing or extra field is a bug, never sent blank", () => {
    const body = orderedBody(SAVE_HEADER_FIELDS, NS_HEADER);
    eq(Array.from(new URLSearchParams(body).keys()).join(), SAVE_HEADER_FIELDS.join());
    let missing = null;
    try {
      orderedBody(["a", "b"], { a: "1" });
    } catch (error) {
      missing = error;
    }
    assert(missing && /"b"/.test(missing.message), "missing field");
    let extra = null;
    try {
      orderedBody(["a"], { a: "1", c: "2" });
    } catch (error) {
      extra = error;
    }
    assert(extra && /c/.test(extra.message), "extra field");
  });

  /* ------------------------------------------------------- rules */

  await test("bill upload: amounts as IREPS computes them, on the three captured bills", () => {
    const stock = computeAmounts({ rate: 7916, qty: 87, gstRate: 18, supplierState: "06", stateOfSupply: "37" });
    eq(stock.taxable, 688692);
    eq(stock.tax, 123964.56);
    eq(stock.total, 812656.56);
    const ns = computeAmounts({ rate: 27445, qty: 15, gstRate: 18, supplierState: "06", stateOfSupply: "18" });
    eq(ns.taxable, 411675);
    eq(ns.igst, 74101.5);
    eq(ns.total, 485776.5);
    const screen = computeAmounts({ rate: 2983, qty: 100, gstRate: 18, supplierState: "33", stateOfSupply: "09" });
    eq(screen.total, 351994);
    const same = computeAmounts({ rate: 2983, qty: 100, gstRate: 18, supplierState: "33", stateOfSupply: "33" });
    eq(same.cgst, 26847);
    eq(same.sgst, 26847);
    eq(same.igst, 0);
    eq(same.total, 351994);
    const ut = gstSplit(18, "04", "04");
    eq(ut.utgst, 9);
    eq(ut.sgst, 0);
  });

  await test("bill upload: dates, state codes, supplier GSTIN and state of supply derivations", () => {
    eq(invoiceDateToIreps("2026-08-18 00:00:00.000"), "18/08/2026");
    eq(invoiceDateToIreps("2026-08-18"), "18/08/2026");
    eq(invoiceDateToIreps("8/9/2026"), "08/09/2026");
    eq(invoiceDateToIreps("18-Aug-2026"), "18/08/2026");
    eq(invoiceDateToIreps("31/02/2026"), null);
    // live RetrieveInvoiceData sends epoch ms, as a string: 2026-10-29T23:00Z is midnight 30 Oct in UTC+1, 04:30 IST
    eq(invoiceDateToIreps("1793314800000"), "30/10/2026");
    eq(invoiceDateToIreps(1793314800000), "30/10/2026");
    eq(invoiceDateToIreps("20261030"), null);
    eq(stateCodeOf("TN"), "33");
    eq(stateCodeOf("Uttar Pradesh"), "09");
    eq(stateCodeOf("ODISHA"), "21");
    eq(deriveSupplierGstin({ division: "WABHSR" }).value, "33AAGCS8525B1ZL");
    eq(deriveSupplierGstin({ division: "WABRTK" }).value, "06AAGCS8525B1ZI");
    eq(deriveSupplierGstin({ gstinSupplier: "02AAGCS8525B1ZQ", division: "WABHSR" }).value, "02AAGCS8525B1ZQ", "ECM column first");
    eq(deriveSupplierGstin({ division: "XYZ" }), null);
    eq(deriveStateOfSupply({ gstinRecipient: "09AAAGM0289C1ZH" }).value, "09");
    eq(deriveStateOfSupply({ gstinRecipient: "URD", consigneeAddressLine4: "CHENNAI, TN, 600038, IN" }).value, "33");
    eq(deriveStateOfSupply({ gstinRecipient: "URD", consigneeAddressLine4: "HONG KONG, HK, 852, HK" }), null);
    eq(paymentPercentFrom("100% against receipt"), 100);
    eq(paymentPercentFrom("CS 95% on receipt, 5% after"), 95);
    eq(paymentPercentFrom(""), null);
  });

  await test("bill upload: header from the non-stock invoice reproduces the captured saveBillHeader.do values", async () => {
    const form = parseBillForm(await billPage(fixture));
    const receipt = receiptFromCrn(CRN_RECEIPT_RECORD);
    const { values, checks, review } = buildHeader({
      receipt,
      invoice: { ...ECM_INVOICE, amount: "485777", supplyPlace: "coaching Depot/Guwah", partDescription: "" },
      form,
      payAuths: parsePayAuthList(NS.payAuth),
      stockNonstock: "N",
      gstinStatus: { valid: true, message: "Valid GSTIN" },
      overrides: { billDescription: "CLAIM FOR 100% PAYMENT" },
      today: TODAY
    });
    eq(checks.filter((c) => c.level === "error").length, 0, JSON.stringify(checks));
    for (const key of SAVE_HEADER_FIELDS) {
      if (["companyName", "bankAccountNo", "ifscCode"].includes(key)) continue;
      eq(values[key], NS_HEADER[key], `header ${key}`);
    }
    assert(review.find((r) => r.key === "supplierGSTIN").source.includes("WABRTK"), "GSTIN source shown");
  });

  await test("bill upload: header checks - unknown GSTIN / state, future date, bad invoice no., part payment, long place", async () => {
    const form = parseBillForm(await billPage(fixture));
    const receipt = receiptFromCrn(CRN_RECEIPT_RECORD);
    const base = { receipt, form, payAuths: parsePayAuthList(NS.payAuth), stockNonstock: "N", today: TODAY };
    const errors = (input) => buildHeader({ ...base, ...input }).checks.filter((c) => c.level === "error").map((c) => c.text).join(" | ");
    assert(/Supplier GSTIN is not known/.test(errors({ invoice: { ...ECM_INVOICE, division: "" } })), "no GSTIN");
    assert(/not one of this IREPS account/.test(errors({ invoice: { ...ECM_INVOICE, gstinSupplier: "29ABCDE1234F1Z5" } })), "foreign GSTIN");
    assert(/State of supply is not known/.test(errors({ invoice: { ...ECM_INVOICE, gstinRecipient: "URD" } })), "no state");
    assert(/in the future/.test(errors({ invoice: { ...ECM_INVOICE, invoiceDate: "2027-01-01" } })), "future");
    assert(/not accepted by IREPS/.test(errors({ invoice: { ...ECM_INVOICE, invoiceNumber: "INV#2026_000123456" } })), "invoice no.");
    assert(/only 100%/.test(errors({ invoice: { ...ECM_INVOICE, paymentTerm: "90% on receipt" } })), "part payment");
    assert(/not valid/.test(errors({ invoice: ECM_INVOICE, gstinStatus: { valid: false, message: "Inactive GSTIN" } })), "inactive GSTIN");
    const long = buildHeader({ ...base, invoice: ECM_INVOICE });
    eq(long.values.placeOfSupply, "coaching Depot/Guwah", "cut to 20");
    assert(long.checks.some((c) => c.level === "warning" && /shortened/.test(c.text)), "warned");
    const chosen = buildHeader({ ...base, invoice: { ...ECM_INVOICE, division: "" }, overrides: { supplierGSTIN: "06aagcs8525b1zi", stateOfSupply: "18" } });
    eq(chosen.values.supplierGSTIN, "06AAGCS8525B1ZI");
    eq(chosen.values.supplierState, "06");
  });

  await test("bill upload: item from the captured answers reproduces the non-stock saveBillDetails.do request exactly", () => {
    const { values, checks, amounts } = buildItem({
      header: NS_HEADER,
      billRegNo: "3744921",
      receipt: receiptFromCrn(CRN_RECEIPT_RECORD),
      invoice: ECM_INVOICE,
      item: parseItemDetails(NS.item),
      roNo: "35294-26-66158",
      ro: parseRoDetails(NS.ro),
      railwayGstins: [{ value: "18AAAGM0289C1ZI" }]
    });
    eq(checks.length, 0, JSON.stringify(checks));
    eq(amounts.total, 485776.5);
    eq(orderedBody(SAVE_DETAILS_FIELDS, values), NS_DETAILS);
  });

  await test("bill upload: item checks - amount mismatch, charges on the PO, GSTIN outside the list, consignee in another state", () => {
    const input = { header: NS_HEADER, billRegNo: "1", receipt: receiptFromCrn(CRN_RECEIPT_RECORD), invoice: ECM_INVOICE, item: parseItemDetails(NS.item), roNo: "35294-26-66158", ro: parseRoDetails(NS.ro), railwayGstins: [{ value: "18AAAGM0289C1ZI" }] };
    const errorsOf = (over) => buildItem({ ...input, ...over }).checks.filter((c) => c.level === "error").map((c) => c.text).join(" | ");
    assert(/differs from what IREPS computes/.test(errorsOf({ invoice: { ...ECM_INVOICE, amount: 500000 } })), "amount");
    const withFreight = parseItemDetails(NS.item.replace("0^^0^^0^^0^^0^^18", "0^^0^^0^^150^^0^^18"));
    assert(/frt charge/.test(errorsOf({ item: withFreight })), "freight");
    assert(/not in IREPS' railway GSTIN list/.test(errorsOf({ railwayGstins: [{ value: "29AAAGM0289C1ZF" }] })), "rly GSTIN");
    assert(/differs from the receipt quantity/.test(errorsOf({ invoice: { ...ECM_INVOICE, quantity: "14" } })), "qty");
    // consignee in another state than the saved state of supply (review 3.2): IREPS's page takes
    // only a railway GSTIN of the state of supply, so the consignee's own is never sent
    const offered = [{ value: "18AAAGM0289C1ZI" }, { value: "29AAAGM0289C1ZF", label: "29AAAGM0289C1ZF-Karnataka" }, { value: "29AAACI0681C1ZV", label: "29AAACI0681C1ZV-~Karnataka-IRFC" }];
    const otherState = buildItem({ ...input, header: { ...NS_HEADER, stateOfSupply: "29" }, railwayGstins: offered });
    eq(otherState.values.rlyGSTIN, "29AAAGM0289C1ZF", "the state of supply's GSTIN with the consignee's PAN");
    assert(otherState.checks.some((c) => c.level === "warning" && /consignee's GSTIN 18AAAGM0289C1ZI is in state 18 \(Assam\)/.test(c.text) && /uses 29AAAGM0289C1ZF-Karnataka/.test(c.text)), JSON.stringify(otherState.checks));
    eq(otherState.checks.filter((c) => c.level === "error").length, 0, JSON.stringify(otherState.checks));
    eq(otherState.values.igstRate, "18", "IGST as the saved header says");
    const noGstinOfState = buildItem({ ...input, header: { ...NS_HEADER, stateOfSupply: "29" } });
    eq(noGstinOfState.values.rlyGSTIN, "", "never the consignee's GSTIN of another state");
    assert(/DocLink cannot tell which one to use \(it offers none\)/.test(errorsOf({ header: { ...NS_HEADER, stateOfSupply: "29" } })), "no railway GSTIN of the state of supply: the item stops");
    const sameState = buildItem({ ...input, header: { ...NS_HEADER, supplierState: "18", supplierGSTIN: "18X" } });
    eq(sameState.values.cgstRate, "9");
    eq(sameState.values.sgstRate, "9");
    eq(sameState.values.igstRate, "0");
    eq(sameState.values.cgstAmount, "37050.75");
    eq(precheckReceipt({ receipt: receiptFromCrn(CRN_RECEIPT_RECORD), invoice: { amount: 400000 }, ro: parseRoDetails(NS.ro) }).length, 1, "precheck amount");
  });

  /* ------------------------------------------------------- ECM */

  await test("bill upload: ECM invoice answers in any envelope; prefixed / flat columns; Sent to Doculink", () => {
    const flat = normaliseInvoice({ invoiceNumber: "1331000660", salesInvoiceDate: "2026-08-18 00:00:00.000", onivla: 63749.91, serviceAccountingCode: "73269099", division: "WABHSR", "Sent to Doculink": "" });
    eq(flat.invoiceNumber, "1331000660");
    eq(flat.amount, 63749.91);
    eq(flat.hsn, "73269099");
    eq(flat.sentToDoculink, undefined);
    const doc = normaliseInvoice({ uid: "u1", properties: { "InvoiceCertificateSchema:invoiceNumber": "X1", "InvoiceCertificateSchema:onivla": "10", "invoice:offeredQuantity": "4" } });
    eq(doc.invoiceNumber, "X1");
    eq(doc.quantity, "4");
    eq(invoiceRecords([{ invoiceNumber: "A" }]).length, 1);
    eq(invoiceRecords({ entries: [{}, {}] }).length, 2);
    eq(invoiceRecords({ "entity-type": "string", value: JSON.stringify([{ invoiceNumber: "A" }]) }).length, 1);
    eq(invoiceRecords({ invoiceNumber: "A" }).length, 1);
    eq(invoiceRecords({ bytes: new TextEncoder().encode('{"invoices":[{"invoiceNumber":"B"}]}'), contentType: "text/plain" })[0].invoiceNumber, "B");
    eq(invoiceRecords("not json").length, 0);
    eq(isSentToDoculink("Y"), true);
    eq(isSentToDoculink("2026-10-01"), true);
    eq(isSentToDoculink("N"), false);
    eq(isSentToDoculink(null), false);
    eq(manualInvoice({ invoiceNumber: " 123 ", amount: "", hsn: "8545" }).amount, undefined);
  });

  await test("bill upload: retrieveInvoice -> one invoice; none / several / already sent stop with their own codes", async () => {
    let sent = null;
    const automation = (answer) => async (op, params) => ((sent = { op, params }), answer);
    const key = { customerPO: "40265077101806", customerPOSrNo: "001", invoiceQuantity: 15 };
    const one = await retrieveInvoice(key, { automation: automation([{ invoiceNumber: "1061000262", onivla: 485776.5 }]) });
    eq(one.invoiceNumber, "1061000262");
    eq(sent.op, "RetrieveInvoiceData");
    eq(JSON.stringify(sent.params), JSON.stringify({ customerPO: "40265077101806", customerPOSrNo: "001", invoiceQuantity: "15" }));
    await rejects(retrieveInvoice(key, { automation: automation([]) }), BILL_ERROR.ECM_NOT_FOUND);
    await rejects(retrieveInvoice(key, { automation: automation([{ invoiceNumber: "1" }, { invoiceNumber: "2" }]) }), BILL_ERROR.ECM_AMBIGUOUS);
    await rejects(retrieveInvoice(key, { automation: automation([{ invoiceNumber: "1", sentToDoculink: "Y" }]) }), BILL_ERROR.ECM_ALREADY_SENT);
    const fresh = await retrieveInvoice(key, { automation: automation([{ invoiceNumber: "1", sentToDoculink: "Y" }, { invoiceNumber: "2" }]) });
    eq(fresh.invoiceNumber, "2", "the one not sent yet");
    await rejects(retrieveInvoice(key, { automation: async () => { throw new Error("socket hang up"); } }), BILL_ERROR.ECM_UNAVAILABLE);
  });

  await test("bill upload: callEcmAutomation posts the spec's request (site/api path, json+nxrequest, params, bearer)", async () => {
    resetEcmDirectState();
    applyEcmConfig({ ecmBackendAws: false, ecm: { env: "TEST", domain: "http://ecm.test:8080", clientId: "id", clientSecret: "secret" } });
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify([{ invoiceNumber: "1061000262" }]), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const answer = await callEcmAutomation("RetrieveInvoiceData", { customerPO: "P", customerPOSrNo: "001", invoiceQuantity: "15" }, { fetch: fetchImpl, hostPermissions: ["http://ecm.test:8080/*"] });
    const call = calls[1];
    eq(call.url, "http://ecm.test:8080/nuxeo/site/api/v1/automation/RetrieveInvoiceData");
    eq(call.init.method, "POST");
    eq(call.init.headers["Content-Type"], "application/json+nxrequest");
    eq(call.init.headers.Authorization, "Bearer tok");
    eq(call.init.body, JSON.stringify({ params: { customerPO: "P", customerPOSrNo: "001", invoiceQuantity: "15" } }));
    eq(answer[0].invoiceNumber, "1061000262");
    resetEcmDirectState();
  });

  await test("bill upload: ECM document query (types + invoice / PO + both sites) and the local document set", async () => {
    const q = billDocumentsQuery({ kinds: ["generatedMerge", "workCertificate"], field: "invoice_number", value: "1061000262", env: "TEST" });
    assert(q.includes("InvoiceCertificateSchema:type IN ('generatedMerge', 'workCertificate')"), q);
    assert(q.includes("InvoiceCertificateSchema:invoiceNumber = '1061000262'"), q);
    assert(q.includes("ecm:ancestorId = 'ad5090e5-648d-4f75-8c14-7052e8ac3b72' OR ecm:ancestorId = '34a61f51-10fe-44ce-a669-2ea14dc86ff4'"), q);
    eq(documentNeed(BILL_DOCUMENTS.find((d) => d.code === "IC"), "CONSG"), "not-needed");
    eq(documentNeed(BILL_DOCUMENTS.find((d) => d.code === "IC"), "TPI"), "required");
    eq(documentNeed(BILL_DOCUMENTS.find((d) => d.code === "EDECL"), "CONSG"), "required");

    const pdf = (n) => new Uint8Array([37, 80, 68, 70, 45, ...new Array(n).fill(32)]);
    const docs = BILL_DOCUMENTS.map((document) => ({ document, uid: ["INVOICE", "GCWC", "MODVAT", "WTC", "PO"].includes(document.code) ? `uid-${document.code}` : null, others: document.code === "PO" ? 2 : 0 }));
    const saved = [];
    const result = await collectBillDocuments(
      { invoice: { invoiceNumber: "1061000262" }, receipt: { poNo: "40265077101806" }, inspectionAgency: "CONSG" },
      {
        findBillDocuments: async (key) => (eq(key.invoiceNumber, "1061000262"), docs),
        fetchBillDocument: async (uid) => ({ bytes: uid === "uid-WTC" ? new TextEncoder().encode("<html>login</html>") : uid === "uid-MODVAT" ? pdf(MAX_DOCUMENT_BYTES) : pdf(10) }),
        saveFile: async (bytes, path) => (saved.push(path), { downloadId: saved.length, filename: path.split("/").pop() })
      }
    );
    eq(result.folder, "DocLink/IREPS/BillUpload/1061000262");
    eq(saved.join(), "DocLink/IREPS/BillUpload/1061000262/1061000262_INVOICE.pdf,DocLink/IREPS/BillUpload/1061000262/1061000262_GCWC.pdf,DocLink/IREPS/BillUpload/1061000262/1061000262_PO.pdf");
    const by = Object.fromEntries(result.documents.map((d) => [d.code, d]));
    eq(by.INVOICE.status, "saved");
    eq(by.INVOICE.fileDesc, "INVOICE");
    eq(by.MODVAT.status, "too-large");
    eq(by.WTC.status, "invalid");
    eq(by.EDECL.status, "missing");
    eq(by.EDECL.need, "required");
    eq(by.IC.need, "not-needed");
    assert(/2 older/.test(by.PO.note), by.PO.note);
    eq(result.missingRequired.join(), "Modvat Declaration,WTC (Work Test Certificate),E-Declaration");
  });

  /* ------------------------------------------------------- the flow */

  const receiptNS = () => receiptFromCrn(CRN_RECEIPT_RECORD);

  await test("bill upload flow: prepare reads only (no write), picks Non-Stock from the CRN, checks GSTIN and receipt", async () => {
    const ireps = fakeBillIreps(await billPage(fixture));
    const store = createBillStore(memoryStorageArea());
    const ctx = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: ireps.fetchImpl, store, today: TODAY });
    eq(ireps.writes().length, 0, "nothing written");
    eq(ireps.calls.map((c) => c.path.split("/").pop()).join(), "fetchPODetails.do,populatePayAuthList.do,populatePOSrList.do,getAjaxData.do,populateROList.do,populateRODetails.do");
    eq(ctx.stockNonstock, "N");
    eq(ctx.roNo, "35294-26-66158");
    eq(ctx.header.values.supplierGSTIN, "06AAGCS8525B1ZI");
    eq(ctx.header.values.stateOfSupply, "18");
    eq(ctx.header.checks.filter((c) => c.level === "error").length, 0, JSON.stringify(ctx.header.checks));
    const ajax = ireps.calls[1].headers;
    eq(ajax["X-Requested-With"], "XMLHttpRequest");
    eq(ajax["Content-Type"], "application/x-www-form-urlencoded; charset=UTF-8");
    eq(ireps.calls[0].headers["X-Requested-With"], undefined, "the page load is not an AJAX call");
  });

  await test("bill upload flow: stock / non-stock falls back to the other list; amount mismatch stops before any write", async () => {
    const page = await billPage(fixture);
    const rnoteReceipt = { ...receiptNS(), source: "RNOTE" };
    const store = createBillStore(memoryStorageArea());
    const ireps = fakeBillIreps(page);
    const ctx = await prepareBill({ receipt: rnoteReceipt, invoice: ECM_INVOICE }, { fetch: ireps.fetchImpl, store, today: TODAY });
    eq(ctx.stockNonstock, "N", "S had no PO Sr 001, N had");
    assert(ctx.header.checks.some((c) => c.level === "warning" && /Non-Stock/.test(c.text)), "warned");

    const off = await prepareBill({ receipt: receiptNS(), invoice: { ...ECM_INVOICE, amount: 490000 } }, { fetch: fakeBillIreps(page).fetchImpl, store, today: TODAY });
    assert(off.header.checks.some((c) => c.level === "error" && /differs from the receipt's value/.test(c.text)), "precheck error");
    const writer = fakeBillIreps(page);
    await rejects(createDraftBill(off, { acknowledged: true }, { fetch: writer.fetchImpl, store, today: TODAY }), BILL_ERROR.CHECKS_FAILED);
    eq(writer.writes().length, 0, "nothing written");
  });

  await test("bill upload flow: create writes header then item, records the bill, and never creates a second one", async () => {
    const page = await billPage(fixture);
    const area = memoryStorageArea();
    const store = createBillStore(area);
    const ireps = fakeBillIreps(page);
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const ctx = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE, overrides: { billDescription: "CLAIM FOR 100% PAYMENT" } }, deps);
    // the place of supply was shortened (a warning) -> needs the user's confirmation
    await rejects(createDraftBill(ctx, { acknowledged: false }, deps), BILL_ERROR.CHECKS_FAILED);
    eq(ireps.writes().length, 0);
    const done = await createDraftBill(ctx, { acknowledged: true }, deps);
    eq(done.outcome, "item-saved");
    eq(done.context.billRegNo, "3744921");
    eq(done.context.dispatchNo, "3894570");
    const writes = ireps.writes();
    eq(writes.length, 2);
    eq(Array.from(new URLSearchParams(writes[0].body).keys()).join(), SAVE_HEADER_FIELDS.join(), "header field order");
    eq(new URLSearchParams(writes[0].body).get("stateOfSupply"), "18");
    eq(writes[1].body.replace(/description=[^&]*/, ""), NS_DETAILS.replace(/description=[^&]*/, ""), "item body = the captured one");
    const entry = await store.get(receiptNS().key);
    eq(entry.status, "item-saved");
    eq(entry.billRegNo, "3744921");
    assert(!JSON.stringify(area.data).includes("000111222333"), "no bank account stored");
    // a second run (new prepare) for the same receipt refuses
    const again = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps);
    assert(again.header.checks.some((c) => c.level === "error" && /already created bill 3744921/.test(c.text)), "flagged in review");
    await rejects(createDraftBill(again, { acknowledged: true }, deps), BILL_ERROR.DRAFT_EXISTS);
    eq(ireps.writes().length, 2, "still two writes");
    // "Start fresh": forgetting the earlier bill clears the stop and allows a new draft
    const fresh = await forgetBill(again, deps);
    eq(fresh.forgotten.billRegNo, "3744921");
    eq(await store.get(receiptNS().key), null, "record removed");
    eq(ireps.writes().length, 2, "forgetting writes nothing to IREPS");
    assert(!fresh.context.header.checks.some((c) => /already created bill/.test(c.text)), "stop cleared");
    const second = await createDraftBill(fresh.context, { acknowledged: true }, deps);
    eq(second.outcome, "item-saved");
    eq(ireps.writes().length, 4, "new header + item");
    eq((await store.get(receiptNS().key)).status, "item-saved");
  });

  await test("bill upload flow: item warnings wait for confirmation; an item failure keeps the created bill", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    // the consignee is in another state than the header's state of supply -> item warning
    const ireps = fakeBillIreps(page, { override: (path) => (path.endsWith("fetchPOItemDetails.do") ? NS.item.replace("Assam, GST# 18AAAGM0289C1ZI", "Karnataka, GST# 29AAAGM0289C1ZF") : null) });
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const invoice = { ...ECM_INVOICE, supplyPlace: "Guwahati" };
    const ctx = await prepareBill({ receipt: receiptNS(), invoice }, deps);
    const first = await createDraftBill(ctx, { acknowledged: false }, deps);
    eq(first.outcome, "item-review");
    eq(ireps.writes().length, 1, "header only");
    assert(first.context.item.checks.some((c) => c.level === "warning" && /consignee's GSTIN 29AAAGM0289C1ZF is in state 29 \(Karnataka\)/.test(c.text)), JSON.stringify(first.context.item.checks));
    eq((await store.get(receiptNS().key)).status, "header-saved");
    const second = await saveItem(first.context, { acknowledged: true }, deps);
    eq(second.outcome, "item-saved");
    eq(ireps.writes().length, 2);
    eq(new URLSearchParams(ireps.writes()[1].body).get("rlyGSTIN"), "18AAAGM0289C1ZI", "the state of supply's railway GSTIN, the one IREPS's page keeps");
    await rejects(saveItem(second.context, { acknowledged: true }, deps), BILL_ERROR.DRAFT_EXISTS);

    // IREPS refuses the item: the error carries the bill reg no. and the context
    const store2 = createBillStore(memoryStorageArea());
    const refusing = fakeBillIreps(page, { override: (path) => (path.endsWith("saveBillDetails.do") ? "Claim Amount is exceeding balance amount" : null) });
    const deps2 = { fetch: refusing.fetchImpl, store: store2, today: TODAY };
    const ctx2 = await prepareBill({ receipt: receiptNS(), invoice }, deps2);
    const error = await rejects(createDraftBill(ctx2, { acknowledged: true }, deps2), BILL_ERROR.IREPS_REJECTED);
    eq(error.billRegNo, "3744921");
    eq(error.context.billRegNo, "3744921");
    eq((await store2.get(receiptNS().key)).status, "header-saved");
  });

  await test("bill upload flow: review applies the user's GSTIN / state / place and re-checks the GSTIN with IREPS", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    const ireps = fakeBillIreps(page);
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const ctx = await prepareBill({ receipt: receiptNS(), invoice: { ...ECM_INVOICE, division: "", gstinRecipient: "URD" } }, deps);
    assert(ctx.header.checks.some((c) => /Supplier GSTIN is not known/.test(c.text)));
    const before = ireps.calls.length;
    const next = await reviewBill(ctx, { supplierGSTIN: "06AAGCS8525B1ZI", stateOfSupply: "18", placeOfSupply: "Guwahati" }, deps);
    eq(ireps.calls.slice(before).map((c) => c.path.split("/").pop()).join(), "getAjaxData.do", "only the GSTIN check");
    eq(next.header.values.supplierGSTIN, "06AAGCS8525B1ZI");
    eq(next.header.values.placeOfSupply, "Guwahati");
    eq(next.header.checks.filter((c) => c.level === "error").length, 0, JSON.stringify(next.header.checks));
  });

  await test("bill upload flow: login page / unbillable receipt / foreign bill page", async () => {
    const store = createBillStore(memoryStorageArea());
    const login = await fixture("login-page.html");
    await rejects(prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: fakeBillIreps(login).fetchImpl, store }), IREPS_ERROR.SESSION_EXPIRED);
    await rejects(prepareBill({ receipt: { ...receiptNS(), billClaim: null }, invoice: ECM_INVOICE }, { fetch: fakeBillIreps(login).fetchImpl, store }), BILL_ERROR.NOT_BILLABLE);
    await rejects(prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: fakeBillIreps("<html><body>Something else</body></html>").fetchImpl, store }), BILL_ERROR.FORM_INVALID);
    const otherPo = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: fakeBillIreps(await billPage(fixture, { poNumber: "99999999999999" })).fetchImpl, store, today: TODAY });
    assert(otherPo.header.checks.some((c) => c.level === "error" && /not 40265077101806/.test(c.text)), "PO mismatch");
  });

  /* ------------------------------------------------- JSON file invoice source */

  /** An ECM-shaped file record for a receipt (the columns RetrieveInvoiceData answers with). */
  const fileRecord = (r, extra = {}) => ({
    invoiceNumber: "1061000262", salesInvoiceDate: "2026-08-08", onivla: 485776.5, quantity: r.qty, serviceAccountingCode: "85452000",
    customerPONumber: r.poNo, customerPOSrNumber: r.poSr, division: "WABRTK", gstinRecipient: "18AAAGM0289C1ZI", supplyPlace: "coaching Depot/Guwahati",
    taxCode: "IGST", "Sent to Doculink": "", ...extra
  });

  await test("invoice file: list, { invoices: [...] } and single invoice are read; notes ignored; bad files refused", async () => {
    eq(parseInvoiceFile(JSON.stringify([{ invoiceNumber: "A1" }, { invoiceNumber: "A2" }]), "a.json").records.length, 2);
    const wrapped = parseInvoiceFile(JSON.stringify({ _about: "note", receipt: { poNumber: "x" }, invoices: [{ invoiceNumber: "B1" }] }), "b.json");
    eq(wrapped.records.length, 1);
    eq(wrapped.name, "b.json");
    eq(parseInvoiceFile(JSON.stringify({ invoiceNumber: "C1", quantity: 3 }), "c.json").records.length, 1);
    const refused = async (text) => rejects((async () => parseInvoiceFile(text, "bad.json"))(), BILL_ERROR.FILE_INVALID);
    await refused("");
    await refused("{ not json");
    await refused(JSON.stringify({ notes: "no invoices here" }));
    await refused(JSON.stringify({ invoices: [{ quantity: 1 }] }));
    await refused(" ".repeat(MAX_INVOICE_FILE_BYTES + 1) + "[]");
  });

  await test("invoice file: matched by PO + PO Sr + quantity (numbers by value), stops on none / several / already sent", async () => {
    const receipt = receiptNS();
    const key = receiptInvoiceKey(receipt);
    const other = fileRecord(receipt, { invoiceNumber: "OTHER", customerPONumber: "11111111111111" });
    const file = { name: "inv.json", records: [other, fileRecord(receipt, { customerPOSrNumber: String(Number(receipt.poSr)), quantity: `${receipt.qty}.0` })] };
    const inv = invoiceFromFile(file, key);
    eq(inv.invoiceNumber, "1061000262", "'1' matches PO Sr '001', '15.0' matches qty 15");
    eq(inv.source, "JSON file inv.json");
    eq(inv.amount, 485776.5);
    eq(inv.hsn, "85452000");
    const fails = (records, code) => rejects((async () => invoiceFromFile({ name: "inv.json", records }, key))(), code);
    await fails([other], BILL_ERROR.FILE_NO_MATCH);
    await fails([fileRecord(receipt, { quantity: receipt.qty + 1 })], BILL_ERROR.FILE_NO_MATCH);
    await fails([fileRecord(receipt), fileRecord(receipt, { invoiceNumber: "1061000263" })], BILL_ERROR.FILE_AMBIGUOUS);
    await fails([fileRecord(receipt, { "Sent to Doculink": "Y" })], BILL_ERROR.ECM_ALREADY_SENT);
    // a sent duplicate does not make the fresh one ambiguous
    eq(invoiceFromFile({ name: "inv.json", records: [fileRecord(receipt, { invoiceNumber: "OLD", "Sent to Doculink": "2026-08-01" }), fileRecord(receipt)] }, key).invoiceNumber, "1061000262");
    const missing = await (async () => {
      try {
        invoiceFromFile({ name: "inv.json", records: [other] }, key);
      } catch (error) {
        return error.detail;
      }
    })();
    assert(/inv\.json has no invoice for PO .* It holds: OTHER \(PO 11111111111111/.test(missing), missing);
  });

  await test("invoice file: the same invoice from a file and from ECM builds the same IREPS header", async () => {
    const page = await billPage(fixture);
    const receipt = receiptNS();
    const fromFile = invoiceFromFile(parseInvoiceFile(JSON.stringify({ invoices: [fileRecord(receipt)] }), "bills.json"), receiptInvoiceKey(receipt));
    const viaFile = await prepareBill({ receipt, invoice: fromFile }, { fetch: fakeBillIreps(page).fetchImpl, store: createBillStore(memoryStorageArea()), today: TODAY });
    const viaEcm = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: fakeBillIreps(page).fetchImpl, store: createBillStore(memoryStorageArea()), today: TODAY });
    eq(JSON.stringify(viaFile.header.values), JSON.stringify(viaEcm.header.values));
    eq(viaFile.header.checks.filter((c) => c.level === "error").length, 0, JSON.stringify(viaFile.header.checks));
    const invoiceRow = viaFile.header.review.find((r) => r.key === "invoiceNo");
    eq(invoiceRow && invoiceRow.source, "JSON file bills.json");
  });

  await test("invoice file: test/mock/sample_upload.json loads and matches the mock's R-Note 4800000001", async () => {
    const file = parseInvoiceFile(await fixture("../mock/sample_upload.json"), "sample_upload.json");
    eq(file.records.length, 2);
    const inv = invoiceFromFile(file, { customerPO: "11260000100001", customerPOSrNo: "001", invoiceQuantity: "87" });
    eq(inv.invoiceNumber, "1331000901");
    eq(inv.amount, 812656.56);
    eq(inv.division, "WABHSR");
    // the live receipt's test entry: a valid but obviously-test invoice no. and date
    const live = invoiceFromFile(file, { customerPO: "07250320103232", customerPOSrNo: "003", invoiceQuantity: "86" });
    assert(/^DOCLINK-TEST-[0-9]+$/.test(live.invoiceNumber) && live.invoiceNumber.length <= 16, `test invoice no.: ${live.invoiceNumber}`);
    eq(invoiceDateToIreps(live.invoiceDate), "05/11/2026");
  });

  /* ------------------------------------------------- review fixes M25, M26, L13, L14 */

  await test("bill upload flow (M25): a bad HSN code stops before the draft bill is created, whatever the invoice source", async () => {
    eq(hsnCheck({ hsn: "85452000" }), null);
    eq(hsnCheck({ hsn: "8545" }), null);
    eq(hsnCheck({ hsn: " 8545 2000 " }), null, "spaces removed, as the item sends it");
    eq(hsnCheck({ hsn: 85452000 }), null, "a number from ECM");
    for (const bad of ["12", "", "123456789", "8545200A", undefined]) assert(hsnCheck({ hsn: bad }), `HSN ${bad} refused`);

    // the header stops on it, so no draft is left behind (before: header saved, then the item blocked)
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    const ireps = fakeBillIreps(page);
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const ctx = await prepareBill({ receipt: receiptNS(), invoice: { ...ECM_INVOICE, hsn: "12" } }, deps);
    assert(ctx.header.checks.some((c) => c.level === "error" && c.text === 'HSN code "12" must be 4 to 8 digits.'), JSON.stringify(ctx.header.checks));
    await rejects(createDraftBill(ctx, { acknowledged: true }, deps), BILL_ERROR.CHECKS_FAILED);
    eq(ireps.writes().length, 0, "nothing written to IREPS");
    eq(await store.get(receiptNS().key), null, "no bill recorded");
    const item = buildItem({ header: NS_HEADER, billRegNo: "1", receipt: receiptNS(), invoice: { ...ECM_INVOICE, hsn: "12" }, item: parseItemDetails(NS.item), roNo: "35294-26-66158", ro: parseRoDetails(NS.ro), railwayGstins: [{ value: "18AAAGM0289C1ZI" }] });
    assert(item.checks.some((c) => c.level === "error" && /HSN code "12"/.test(c.text)), "the item keeps its own check");

    // every source is checked the same way before IREPS is read: ECM, a JSON file, typed by hand
    const receipt = receiptNS();
    let asked = null;
    const ecm = (invoice) => ({ retrieveInvoice: async (key) => ((asked = key), invoice) });
    eq((await invoiceForReceipt({ receipt, mode: "ecm" }, ecm(ECM_INVOICE))).invoiceNumber, "1061000262");
    eq(JSON.stringify(asked), JSON.stringify(receiptInvoiceKey(receipt)), "ECM is asked with the receipt's key");
    const noHsnEcm = await rejects(invoiceForReceipt({ receipt, mode: "ecm" }, ecm({ ...ECM_INVOICE, hsn: undefined })), BILL_ERROR.INVOICE_INVALID);
    eq(noHsnEcm.detail, "Invoice 1061000262 in ECM has no HSN code.");
    const badEcm = await rejects(invoiceForReceipt({ receipt, mode: "ecm" }, ecm({ ...ECM_INVOICE, hsn: "12" })), BILL_ERROR.INVOICE_INVALID);
    eq(badEcm.detail, 'Invoice 1061000262 in ECM: HSN code "12" must be 4 to 8 digits.');
    await rejects(invoiceForReceipt({ receipt, mode: "ecm" }, ecm({ ...ECM_INVOICE, amount: undefined, invoiceDate: "" })), BILL_ERROR.INVOICE_INVALID, "ECM invoice without date and amount");
    const file = (extra) => ({ name: "inv.json", records: [fileRecord(receipt, extra)] });
    eq((await invoiceForReceipt({ receipt, mode: "file", file: file() })).hsn, "85452000");
    const badFile = await rejects(invoiceForReceipt({ receipt, mode: "file", file: file({ serviceAccountingCode: "12" }) }), BILL_ERROR.INVOICE_INVALID);
    eq(badFile.detail, 'Invoice 1061000262 in inv.json: HSN code "12" must be 4 to 8 digits.');
    const noHsnFile = await rejects(invoiceForReceipt({ receipt, mode: "file", file: file({ serviceAccountingCode: "" }) }), BILL_ERROR.INVOICE_INVALID);
    eq(noHsnFile.detail, "Invoice 1061000262 in inv.json has no HSN code.");
    const typed = { invoiceNumber: "1061000262", invoiceDate: "2026-08-08", amount: "485776.5", quantity: "15", hsn: "85452000" };
    eq((await invoiceForReceipt({ receipt, mode: "manual", fields: typed })).source, "entered by you");
    eq((await rejects(invoiceForReceipt({ receipt, mode: "manual", fields: { ...typed, hsn: "12" } }), BILL_ERROR.INVOICE_INVALID)).detail, 'HSN code "12" must be 4 to 8 digits.');
    eq((await rejects(invoiceForReceipt({ receipt, mode: "manual", fields: { ...typed, hsn: "" } }), BILL_ERROR.INVOICE_INVALID)).detail, "Enter the HSN code.");
  });

  /** The panel's view of a bill, as bill-upload-job.js publicState builds it. */
  const publicBill = (c) => ({
    receipt: c.receipt,
    billRegNo: c.billRegNo || (c.existing && c.existing.billRegNo) || null,
    existing: c.existing || null,
    documentsOnBill: c.documentsOnBill || null,
    forgottenBills: c.forgottenBills || []
  });

  await test("bill upload (M26): Start fresh keeps the forgotten draft's number on screen and says where it is in IREPS", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    const ireps = fakeBillIreps(page);
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    eq((await createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps), { acknowledged: true }, deps)).outcome, "item-saved");
    const again = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps);
    const before = startFreshText(publicBill(again));
    eq(before.offer, true, "offers Start fresh");
    assert(/draft bill 3744921/.test(before.text) && /Bills for Pay/.test(before.text), before.text);

    const { context } = await forgetBill(again, deps);
    eq(JSON.stringify(context.forgottenBills), JSON.stringify([{ billRegNo: "3744921", status: "item-saved" }]));
    const after = startFreshText(publicBill(context));
    eq(after.offer, false, "nothing left to forget");
    assert(/forgot draft bill 3744921/.test(after.text) && /still in IREPS/.test(after.text) && /Bills for Pay/.test(after.text), after.text);
    eq(ireps.writes().length, 2, "forgetting writes nothing to IREPS");
    eq(startFreshText(publicBill({ receipt: receiptNS() })), null, "no box for a receipt without an earlier bill");

    // the new bill's last steps still remind the user of the old draft
    const second = await createDraftBill(context, { acknowledged: true }, { ...deps, fetch: fakeBillIreps(page, { billRegNo: "3744999" }).fetchImpl });
    eq(second.outcome, "item-saved");
    const steps = finishSteps({ step: "done", documents: null, bill: publicBill(second.context) });
    assert(steps[0].includes("click bill 3744999"), steps[0]);
    assert(steps.some((t) => t.startsWith("Draft bill 3744921, which DocLink forgot when you chose Start fresh, is still in IREPS")), steps.join("\n"));
  });

  await test("bill upload panel (L13): Finish in IREPS asks only for the documents that are not on the bill yet", () => {
    const receipt = { source: "RNOTE", poNo: "11260000100001" };
    const row = (code, label, fileDesc, need, status) => ({ code, label, fileDesc, need, status });
    const documents = {
      folder: "DocLink/IREPS/BillUpload/1331000901",
      documents: [
        row("INVOICE", "Invoice", "INVOICE", "required", "saved"),
        row("GCWC", "GC/WC", "GUARANTEE WARRANTY CERTIFICATE", "required", "saved"),
        row("EDECL", "E-Declaration", "E INVOICING DECLARATION", "required", "missing"),
        row("IC", "IC", "INSPECTION CERTIFICATE", "not-needed", "saved"),
        row("MA", "DP/MA", "MODIFICATION ADVICE", "optional", "missing"),
        row("PO", "PO copy", "PURCHASE ORDER", "optional", "saved")
      ]
    };
    const system = { fileName: "4800000001.pdf", description: "RNOTE / CRN - SYSTEM UPLOAD" };
    const state = (documentsOnBill, docs = documents) => ({ step: "done", documents: docs, bill: { receipt, billRegNo: "3900001", documentsOnBill, forgottenBills: [] } });

    // the invoice was uploaded from DocLink: it is not asked for again
    const steps = finishSteps(state([system, { fileName: "1331000901_INVOICE.pdf", description: "invoice" }]));
    const text = steps.join("\n");
    assert(steps[0].startsWith("In IREPS open PO Search > Receipt Note (R-NOTE) for PO 11260000100001 and click bill 3900001"), steps[0]);
    assert(steps.includes("Already on the bill, so don't attach it again: invoice."), text);
    const attach = steps.find((t) => t.startsWith("Attach the files DocLink saved in Downloads/DocLink/IREPS/BillUpload/1331000901/")) || "";
    const listed = /not on the bill yet: (.*)\. For each one/.exec(attach);
    eq(listed && listed[1], "GC/WC; PO copy (if applicable)", "neither the uploaded invoice nor the IC this inspection does not need");
    const own = steps.find((t) => t.startsWith("Attach your own copy of what DocLink could not get from ECM")) || "";
    assert(own.endsWith(': E-Declaration, not in ECM, description "E INVOICING DECLARATION".'), `the description to type is given, the list shows none for it: ${text}`);
    assert(!/DP\/MA|SYSTEM UPLOAD/.test(text), "an optional document ECM lacks and IREPS's own receipt upload are not listed");
    eq(steps.slice(-2).join(" | "), "Click Generate Preview and check every value against the invoice. | Click Sign & Submit Bill, select your DSC and enter the PIN.");

    // everything DocLink found is on the bill: nothing left to attach
    const onBill = ["INVOICE", "GUARANTEE WARRANTY CERTIFICATE", "E INVOICING DECLARATION", "PURCHASE ORDER"].map((description) => ({ fileName: "x.pdf", description }));
    const allDone = finishSteps(state([system, ...onBill]));
    assert(allDone.includes("Every document DocLink found in ECM is on the bill already."), allDone.join("\n"));
    assert(!allDone.some((t) => /^Attach (the files|your own copy)/.test(t)), allDone.join("\n"));

    // documents not fetched from ECM: one general step
    const unknown = finishSteps(state([system], null));
    assert(unknown.some((t) => t.startsWith("Attach each document the bill needs")), unknown.join("\n"));
  });

  await test("bill tab transport (L14): the IREPS-tab script is injected once per tab, and again only after the page lost it", async () => {
    const realChrome = globalThis.chrome;
    const injected = [];
    const sent = [];
    const hasScript = new Map();
    let cutOff = false;
    globalThis.chrome = {
      runtime: {},
      scripting: {
        executeScript: async ({ target }) => {
          injected.push(target.tabId);
          if (target.tabId === 9403) throw new Error("Cannot access contents of the page");
          hasScript.set(target.tabId, true);
          return [{ frameId: 0, result: null }];
        }
      },
      tabs: {
        get: async (tabId) => ({ id: tabId, url: "http://localhost:8765/epsn/ct/fetchPODetails.do" }),
        sendMessage: async (tabId, message) => {
          sent.push(message.type);
          if (!hasScript.get(tabId)) throw new Error("Could not establish connection. Receiving end does not exist.");
          if (cutOff) throw new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received");
          if (message.type === "DOCLINK_TAB_SAVE_FILE") return { ok: true, status: 200, text: "OK~stored~1" };
          return { ok: true, status: 200, statusText: "OK", url: message.url, redirected: false, contentType: "text/plain", text: "success^^001" };
        }
      }
    };
    const call = (tabId) => tabFetch(tabId)("http://localhost:8765/epsn/ct/populatePOSrList.do", { method: "POST", body: "rly=05" });
    const injections = (tabId) => injected.filter((id) => id === tabId).length;
    const failure = async (promise) => {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      return null;
    };
    try {
      for (let i = 0; i < 3; i++) eq(await (await call(9401)).text(), "success^^001");
      eq(injections(9401), 1, "three calls, one injection");
      eq(sent.length, 3);
      eq(await tabSaveFile(9401)({ relativeDir: "ireps/upload", pdfName: "a.pdf", pdfContent: "x" }), "OK~stored~1");
      eq(injections(9401), 1, "save.php / signer messages use the same injection");

      // the page was reloaded: nothing receives the message, so the script is injected again and the message resent
      hasScript.set(9401, false);
      eq((await call(9401)).status, 200);
      eq(injections(9401), 2, "injected again after the reload");
      eq(sent.length, 6, "the undelivered message, then the same one again");

      // a message the page received and then lost is never resent: the request may have run
      cutOff = true;
      const before = sent.length;
      const cut = await failure(call(9401));
      assert(cut instanceof TypeError && /message channel closed/.test(cut.message), String(cut));
      eq(sent.length, before + 1, "not resent");
      eq(injections(9401), 2, "and not injected again");
      cutOff = false;
      eq((await call(9401)).status, 200);
      eq(injections(9401), 3, "after any failure the next call injects first, in case the page went away");

      // each tab has its own injection; one that cannot be scripted is tried again on the next call
      eq((await call(9402)).status, 200);
      eq(injections(9402), 1);
      assert((await failure(call(9403))) instanceof TypeError, "not scriptable");
      assert((await failure(call(9403))) instanceof TypeError, "still not scriptable");
      eq(injections(9403), 2, "a failed injection is not remembered as done");
    } finally {
      globalThis.chrome = realChrome;
    }
  });

  await test("bill upload: every BILL_* error code has a user text", () => {
    for (const code of Object.values(BILL_ERROR)) {
      assert(ERROR_CATALOG[code], `no catalogue entry for ${code}`);
      eq(describeError(code, { detail: "x" }).code, code);
    }
  });

  /* ---------------------------------------------------------------- document upload */

  const THUMB = "591FB9799E2D08AB09123074F3F166BFCB85CB04";
  const PDF_B64 = btoa("%PDF-1.4\n" + "x".repeat(40000) + "\n%%EOF\n");
  const SIGNED_B64 = btoa("%PDF-1.4 signed " + "y".repeat(3000));
  const signerReply = (sig = SIGNED_B64, thumb = THUMB) =>
    `signature= ${sig}\nCommon name=TEST USER\nSerail No= 1\nSubject DN= CN=TEST\nExpiry Date= 27 Jan, 2027 4:40:00 PM\nThumbprint= ${thumb.toLowerCase()}\nKeyusage= x\nTotalPages= 2\nSignedByteLength= 3016\nOriginalByteLength= 40017\nFileName=\ncompleted`;

  await test("document upload: signer message and frames follow CRISPKI.js", async () => {
    const msg = signerRequest({ pdfBase64: "QUJD", thumbprint: THUMB });
    eq(msg, `action=pdfsign\ntbs=QUJD\nsignaction=2\ncerttype=DS\nexpirycheck=true\nissuername=\nsigntype=detached\ncoordinate=90,90,10,10\nthumbprint=${THUMB}\nreason=IREPS-CRIS\nlocation=New Delhi\npageNo=all\npagination=false`);
    const big = "a".repeat(40000);
    const frames = signerFrames(big);
    eq(frames.length, 3);
    eq(frames[0].length, 16300);
    assert(frames[2].endsWith("completed"), "last frame ends with completed");
    eq(frames.join("").replace(/completed$/, ""), big, "frames rebuild the message");
    eq(signerFrames("short").join(), "shortcompleted");
  });

  await test("document upload: signer reply, save.php answer, IREPS file name and folder", async () => {
    const r = parseSignerReply(signerReply());
    eq(r.signedBase64, SIGNED_B64);
    eq(r.thumbprint, THUMB);
    eq(r.originalBytes, 40017);
    eq(r.pages, 2);
    await rejects(Promise.resolve().then(() => parseSignerReply("signing canceled completed")), BILL_ERROR.SIGN_FAILED);
    await rejects(Promise.resolve().then(() => parseSignerReply("signature= ex\nCommon name=x\ncompleted")), BILL_ERROR.SIGN_FAILED);
    const saved = parseSaveResult("<html><body onload='window.parent.CRISPKI.afterUpload()'>OK~ireps/upload/billDocuments/092026/3744921/3894570/1061000262-GSTMANDATE.pdf~38729</body></html>");
    eq(saved.path, "ireps/upload/billDocuments/092026/3744921/3894570/1061000262-GSTMANDATE.pdf");
    eq(saved.bytes, 38729);
    await rejects(Promise.resolve().then(() => parseSaveResult("<html><body>ERROR~disk</body></html>")), BILL_ERROR.IREPS_REJECTED);
    eq(irepsFileName("1061000262 - GSTMANDATE.pdf"), "1061000262-GSTMANDATE.pdf");
    eq(irepsFileName("MA_04263502102178_003861.pdf"), "MA_04263502102178_003861.pdf");
    eq(irepsFileName("scan (1)"), "scan1.pdf");
    eq(billDocumentsDir({ billRegNo: "3744921", dispatchNo: "3894570" }, new Date(2026, 8, 15)), "ireps/upload/billDocuments/092026/3744921/3894570");
  });

  await test("document upload: sign -> save.php -> uploadBillDocuments.do with the captured fields", async () => {
    const calls = [];
    const bill = { billRegNo: "3744921", dispatchNo: "3894570", vendorCode: ":833", thumbprint: THUMB, spmBillRegNo: "null" };
    const deps = {
      today: new Date(2026, 8, 15),
      signPdf: async (frames) => {
        calls.push({ sign: frames.join("") });
        return signerReply();
      },
      saveFile: async (form) => {
        calls.push({ save: form });
        return `<html><body onload='window.parent.CRISPKI.afterUpload()'>OK~${form.relativeDir}/${form.pdfName}~${form.pdfContent.length}</body></html>`;
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init.body });
        return new Response("OK#2<>35294-26-66158.pdf#ireps/etender/x.pdf#RNOTE / CRN - SYSTEM UPLOAD#15/09/2026 16:39#USER#16873771<>MA_04263502102178_003861.pdf#ireps/upload/billDocuments/092026/3744921/3894570/MA_04263502102178_003861.pdf#MODIFICATION ADVICE#15/09/2026 16:42#USER#16873799<>", { status: 200, headers: { "content-type": "text/plain" } });
      }
    };
    const out = await uploadBillDocument({ bill, file: { name: "MA_04263502102178_003861.pdf", base64: PDF_B64 }, fileDesc: " MODIFICATION ADVICE " }, deps);
    eq(calls.length, 3);
    assert(calls[0].sign.startsWith(`action=pdfsign\ntbs=${PDF_B64}\nsignaction=2`), "the PDF goes to the signer");
    eq(calls[1].save.relativeDir, "ireps/upload/billDocuments/092026/3744921/3894570");
    eq(calls[1].save.pdfContent, SIGNED_B64, "the signed PDF is stored");
    assert(calls[2].url.endsWith("/epsn/ct/uploadBillDocuments.do"), calls[2].url);
    const body = new URLSearchParams(calls[2].body);
    eq(Array.from(body.keys()).join(), UPLOAD_DOCUMENT_FIELDS.join(), "field order");
    eq(calls[2].body, "billRegNo=3744921&dispatchNo=3894570&vendorCode=%3A833&fileName=MA_04263502102178_003861.pdf&filePath=ireps%2Fupload%2FbillDocuments%2F092026%2F3744921%2F3894570%2FMA_04263502102178_003861.pdf&fileDesc=MODIFICATION+ADVICE&spmBillRegNo=null&supplementaryBillType=");
    eq(out.documents.length, 2);
    eq(out.documents[1].description, "MODIFICATION ADVICE");
  });

  await test("document upload: refuses before signing when something is missing", async () => {
    let touched = false;
    const deps = { signPdf: async () => { touched = true; return signerReply(); }, saveFile: async () => { touched = true; return ""; }, fetch: async () => { touched = true; } };
    const bill = { billRegNo: "1", dispatchNo: "2", vendorCode: ":833", thumbprint: THUMB };
    const file = { name: "a.pdf", base64: PDF_B64 };
    await rejects(uploadBillDocument({ bill, file, fileDesc: "MA" }, deps), BILL_ERROR.DOC_INVALID, "short description");
    await rejects(uploadBillDocument({ bill: { ...bill, dispatchNo: null }, file, fileDesc: "MODIFICATION ADVICE" }, deps), BILL_ERROR.NOT_PREPARED, "no dispatch no.");
    await rejects(uploadBillDocument({ bill: { ...bill, thumbprint: "" }, file, fileDesc: "MODIFICATION ADVICE" }, deps), BILL_ERROR.SIGN_FAILED, "no thumbprint");
    await rejects(uploadBillDocument({ bill, file: { name: "a.pdf", base64: btoa("hello world") }, fileDesc: "MODIFICATION ADVICE" }, deps), BILL_ERROR.DOC_INVALID, "not a PDF");
    eq(touched, false, "nothing signed or sent");
    // signed with another certificate -> not stored
    const other = { ...deps, signPdf: async () => signerReply(SIGNED_B64, "AAAA") };
    await rejects(uploadBillDocument({ bill, file, fileDesc: "MODIFICATION ADVICE" }, other), BILL_ERROR.SIGN_FAILED, "other certificate");
    eq(touched, false, "nothing stored");
  });

  await test("bill form: the registered DSC thumbprint is read", async () => {
    const html = (await billPage(fixture)) + `<input type="hidden" name="certThumbprint" value="${THUMB.toLowerCase()}">`;
    eq(parseBillForm(html).certThumbprint, THUMB);
  });

  /* ------------------------------------------------- inspection of 24 Nov 2026, section 3 and 5.4 */

  await test("bill upload flow (3.1): a header whose answer is lost (tab reloaded) stays stopped until the user checked Bills for Pay", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    let lose = true;
    const ireps = fakeBillIreps(page, { override: (path) => (path.endsWith("saveBillHeader.do") && lose ? tabGone() : null) });
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const ctx = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps);
    const lost = await rejects(createDraftBill(ctx, { acknowledged: true }, deps), BILL_ERROR.OUTCOME_UNKNOWN);
    assert(/DocLink sent the bill header for invoice 1061000262 \(PO 40265077101806, PO Sr 001\) to IREPS/.test(lost.detail), lost.detail);
    assert(/the IREPS tab was reloaded, closed or left before IREPS answered/.test(lost.detail) && /Bills for Pay/.test(lost.detail), lost.detail);
    assert(!/try again|network connection/i.test(describeError(lost.code, { detail: lost.detail }).message), "no blind retry is suggested");
    assert(lost.cause && /message channel closed/.test(JSON.stringify(String(lost.cause.cause && lost.cause.cause.cause))), "the transport's own error is kept as the cause");
    eq(ireps.writes().length, 1, "the header was sent once");
    const entry = await store.get(receiptNS().key);
    eq(entry.unknown.step, "header");
    eq(entry.billRegNo, null);
    eq(entry.invoiceNo, "1061000262");
    assert(lost.context.header.checks.some((c) => c.level === "error" && /answer did not arrive/.test(c.text)), "the review shows the stop");

    // no second header, whatever is tried: Create again, a new prepare, Start fresh
    await rejects(createDraftBill(lost.context, { acknowledged: true }, deps), BILL_ERROR.OUTCOME_UNKNOWN);
    const again = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps);
    assert(again.header.checks.some((c) => c.level === "error" && /answer did not arrive/.test(c.text)), "a new prepare shows it too");
    await rejects(createDraftBill(again, { acknowledged: true }, deps), BILL_ERROR.OUTCOME_UNKNOWN);
    await rejects(forgetBill(again, deps), BILL_ERROR.OUTCOME_UNKNOWN, "Start fresh does not clear it");
    eq(startFreshText(publicBill(again)), null, "and is not offered for it");
    eq(ireps.writes().length, 1, "still the one header");

    // only the user's confirmation clears it, and only for the write they read about
    const shown = unknownOutcome(entry);
    assert(/there is no draft bill for invoice 1061000262/.test(shown.confirm), shown.confirm);
    await rejects(confirmCheckedInIreps(again, { step: "header", at: "2000-01-01T00:00:00.000Z" }, deps), BILL_ERROR.CHECKS_FAILED);
    const cleared = await confirmCheckedInIreps(again, { step: shown.step, at: shown.at }, deps);
    eq(await store.get(receiptNS().key), null, "record removed");
    assert(!cleared.header.checks.some((c) => /answer did not arrive/.test(c.text)), "stop gone");
    lose = false;
    eq((await createDraftBill(cleared, { acknowledged: true }, deps)).outcome, "item-saved");
    eq(ireps.writes().length, 3, "the lost header, then header + item");
  });

  await test("bill upload flow (3.1): which answers leave a write open (deadline, network, 5xx, unreadable, a page) and which do not (refusal, 4xx, login page)", async () => {
    const page = await billPage(fixture);
    const login = await fixture("login-page.html");
    const cases = [
      ["the deadline", () => new DOMException("aborted", "AbortError"), BILL_ERROR.OUTCOME_UNKNOWN, /IREPS did not answer within 120 seconds/],
      ["a network error", () => new TypeError("Failed to fetch"), BILL_ERROR.OUTCOME_UNKNOWN, /the connection to IREPS broke/],
      ["HTTP 503", () => new Response("<html><body>Service Unavailable</body></html>", { status: 503 }), BILL_ERROR.OUTCOME_UNKNOWN, /a server error \(HTTP 503\)/],
      ["success without a number", () => "success^^", BILL_ERROR.OUTCOME_UNKNOWN, /answer could not be read/],
      ["an error page", () => "<html><body><h1>Error</h1>Something went wrong</body></html>", BILL_ERROR.OUTCOME_UNKNOWN, /a page instead of its usual answer/],
      ["IREPS's refusal", () => "Bill already registered for Invoice No. 1061000262.", BILL_ERROR.IREPS_REJECTED, null],
      ["HTTP 404", () => new Response("not found", { status: 404 }), BILL_ERROR.REQUEST_FAILED, null],
      ["the login page", () => login, IREPS_ERROR.SESSION_EXPIRED, null]
    ];
    for (const [label, answer, code, why] of cases) {
      const store = createBillStore(memoryStorageArea());
      const ireps = fakeBillIreps(page, { override: (path) => (path.endsWith("saveBillHeader.do") ? answer() : null) });
      const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
      const error = await rejects(createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps), { acknowledged: true }, deps), code, label);
      const entry = await store.get(receiptNS().key);
      if (why) {
        assert(why.test(error.detail), `${label}: ${error.detail}`);
        eq(entry && entry.unknown && entry.unknown.step, "header", `${label}: recorded as unknown`);
      } else {
        eq(entry, null, `${label}: IREPS answered, nothing is recorded and the receipt can be billed`);
      }
    }
    eq(missingAnswerReason(new IrepsError(BILL_ERROR.IREPS_REJECTED, "x")), null);
  });

  await test("bill upload flow (3.1): an item whose answer is lost keeps the bill and stops Save item until the user checked the bill", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    let lose = true;
    const ireps = fakeBillIreps(page, { override: (path) => (path.endsWith("saveBillDetails.do") && lose ? new Response("<html><body>Gateway Timeout</body></html>", { status: 504 }) : null) });
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const lost = await rejects(createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps), { acknowledged: true }, deps), BILL_ERROR.OUTCOME_UNKNOWN);
    eq(lost.billRegNo, "3744921", "the draft bill stays on screen");
    assert(/DocLink sent the item of draft bill 3744921 \(invoice 1061000262\)/.test(lost.detail) && /HTTP 504/.test(lost.detail) && /Bills for Pay/.test(lost.detail), lost.detail);
    const entry = await store.get(receiptNS().key);
    eq(entry.status, "header-saved");
    eq(entry.billRegNo, "3744921");
    eq(entry.unknown.step, "item");
    eq(lost.context.existing.unknown.step, "item", "the panel sees the stop");
    const writes = ireps.writes().length;
    await rejects(saveItem(lost.context, { acknowledged: true }, deps), BILL_ERROR.OUTCOME_UNKNOWN, "no second item");
    eq(ireps.writes().length, writes);
    const shown = unknownOutcome(entry);
    assert(/draft bill 3744921 in IREPS: its item is not saved/.test(shown.confirm), shown.confirm);
    const cleared = await confirmCheckedInIreps(lost.context, shown, deps);
    eq((await store.get(receiptNS().key)).billRegNo, "3744921", "the bill stays recorded");
    eq(cleared.existing.unknown, null);
    lose = false;
    eq((await saveItem(cleared, { acknowledged: true }, deps)).outcome, "item-saved");
    eq((await store.get(receiptNS().key)).status, "item-saved");
  });

  await test("bill upload (3.1): a document registration whose answer is lost stops uploads to that bill until its documents were checked", async () => {
    const store = createBillStore(memoryStorageArea());
    const context = { receipt: receiptNS(), billRegNo: "3744921" };
    await store.put(context.receipt.key, { status: "item-saved", billRegNo: "3744921", dispatchNo: "3894570", invoiceNo: "1061000262", poNumber: "40265077101806", poSr: "001", roNo: "35294-26-66158" });
    let signed = 0;
    let lose = true;
    const deps = {
      store,
      today: new Date(2026, 8, 15),
      signPdf: async () => (signed++, signerReply()),
      saveFile: async (form) => `<html><body>OK~${form.relativeDir}/${form.pdfName}~10</body></html>`,
      fetch: async () => {
        if (lose) throw tabGone();
        return new Response("OK#1<>MA_1.pdf#ireps/upload/x.pdf#MODIFICATION ADVICE#15/09/2026 16:42#USER#1<>", { status: 200 });
      }
    };
    const bill = { billRegNo: "3744921", dispatchNo: "3894570", vendorCode: ":833", thumbprint: THUMB, spmBillRegNo: "null" };
    const input = { bill, file: { name: "MA 0426.pdf", base64: PDF_B64 }, fileDesc: " MODIFICATION ADVICE " };
    const lost = await rejects(addDocumentToBill(context, input, deps), BILL_ERROR.OUTCOME_UNKNOWN);
    assert(/DocLink sent MA0426\.pdf \("MODIFICATION ADVICE"\) to draft bill 3744921 \(invoice 1061000262\)/.test(lost.detail), lost.detail);
    const entry = await store.get(context.receipt.key);
    eq(entry.unknown.step, "document");
    eq(entry.status, "item-saved", "the bill keeps its saved item");
    await rejects(addDocumentToBill(context, input, deps), BILL_ERROR.OUTCOME_UNKNOWN, "no second upload");
    eq(signed, 1, "not even signed again");
    await confirmCheckedInIreps(context, unknownOutcome(entry), { store });
    lose = false;
    eq((await addDocumentToBill(context, input, deps)).documents.length, 1);
    eq((await store.get(context.receipt.key)).unknown, null);
    eq(signed, 2);
  });

  await test("bill upload flow (3.1): a write is recorded before it leaves, so one cut off with the service worker still stops a second one", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    const ireps = fakeBillIreps(page);
    let release;
    const hanging = new Promise((r) => (release = r));
    let reached = false;
    const fetch = async (url, init) => {
      if (String(url).endsWith("saveBillHeader.do")) {
        reached = true;
        await hanging;
      }
      return ireps.fetchImpl(url, init);
    };
    const deps = { fetch, store, today: TODAY };
    const creating = createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps), { acknowledged: true }, deps);
    await until(() => reached, "the header request");
    const pending = await store.get(receiptNS().key);
    eq(pending && pending.unknown && pending.unknown.step, "header", "recorded while IREPS has not answered");
    assert(/background work stopped before IREPS answered/.test(unknownOutcome(pending).text), unknownOutcome(pending).text);
    release();
    eq((await creating).outcome, "item-saved");
    const done = await store.get(receiptNS().key);
    eq(done.unknown, null, "IREPS's answers cleared it");
    eq(done.billRegNo, "3744921");
    eq(done.status, "item-saved");

    // no record, no write: a store that cannot be written stops the header before it is sent
    const broken = createBillStore(memoryStorageArea());
    broken.put = async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    };
    const unsent = fakeBillIreps(page);
    const brokenDeps = { fetch: unsent.fetchImpl, store: broken, today: TODAY };
    const refused = await failureOf(createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, brokenDeps), { acknowledged: true }, brokenDeps));
    assert(refused && /quota exceeded/.test(refused.message), String(refused));
    eq(unsent.writes().length, 0, "nothing was sent to IREPS");
  });

  await test("bill upload job (5.9): each step that ends, failed or not, tells the worker, so a scheduled download that waited may run", async () => {
    const savedChrome = globalThis.chrome;
    const savedFetch = globalThis.fetch;
    globalThis.chrome = { storage: { session: memoryStorageArea(), local: memoryStorageArea() }, runtime: { getPlatformInfo: async () => ({}) } };
    // IREPS cannot be reached: the search step starts, fails at once and ends
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    try {
      let ended = 0;
      const updates = [];
      const job = createBillUploadJob({ broadcast: (type, payload) => updates.push(payload.state), parseSearchPo: async () => ({ records: [] }), onJobEnded: () => void ended++ });
      const started = await job[MESSAGE_TYPES.BILL_UPLOAD_SEARCH]({ poNo: "40265077101806", panelTabId: 1 });
      eq(started.started, true, "the step started");
      await until(() => ended === 1, "the step's end");
      eq(updates[updates.length - 1].busy, false, "told after the job is free again");
    } finally {
      globalThis.chrome = savedChrome;
      globalThis.fetch = savedFetch;
    }
  });

  await test("bill upload job (3.1, 3.13a): a lost answer from the IREPS tab stops Create, the cause is logged, and only 'I checked' frees it", async () => {
    const realChrome = globalThis.chrome;
    const realWarn = console.warn;
    const page = await billPage(fixture);
    const ireps = fakeBillIreps(page);
    const session = memoryStorageArea();
    const local = memoryStorageArea();
    const TAB = 9701;
    let lose = true;
    let headerSent = 0;
    const warnings = [];
    globalThis.chrome = {
      storage: { session, local },
      runtime: { getPlatformInfo: async () => ({}) },
      scripting: { executeScript: async () => [{ result: null }] },
      tabs: {
        get: async (tabId) => ({ id: tabId, url: new URL("/epsn/ct/fetchPODetails.do", IREPS_CONFIG.baseUrl).href }),
        sendMessage: async (tabId, message) => {
          if (message.type !== "DOCLINK_TAB_FETCH") return undefined;
          if (message.url.endsWith("saveBillHeader.do")) {
            headerSent++;
            if (lose) throw new Error(CHANNEL_CLOSED);
          }
          const response = await ireps.fetchImpl(message.url, { method: message.method, headers: message.headers, body: message.body });
          return { ok: true, status: response.status, statusText: "OK", url: message.url, redirected: false, contentType: "text/html", text: await response.text() };
        }
      }
    };
    console.warn = (...args) => (warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")), realWarn(...args));
    try {
      await session.set({ [SESSION_KEYS.BILL_UPLOAD_STATE]: { step: "receipts", busy: false, message: "", poNo: "40265077101806", receipts: [receiptNS()], warnings: [], receiptKey: null, invoiceMode: "manual", invoice: null, context: null, documents: null, docUpload: null, error: null } });
      const updates = [];
      const job = createBillUploadJob({ broadcast: (type, payload) => updates.push(payload.state), parseSearchPo: async () => ({ records: [] }) });
      const step = async (type, msg) => {
        const seen = updates.length;
        const started = await job[type]({ ...msg, panelTabId: TAB });
        eq(started.started, true, `${type} started`);
        await until(() => updates.length >= seen + 2 && !updates[updates.length - 1].busy, type);
        return updates[updates.length - 1];
      };
      const typed = { invoiceNumber: "1061000262", invoiceDate: "2026-08-08", amount: "485776.5", quantity: "15", hsn: "85452000", division: "WABRTK", supplyPlace: "Guwahati" };
      const review = await step(MESSAGE_TYPES.BILL_UPLOAD_PREPARE, { receiptKey: receiptNS().key, invoiceMode: "manual", manualInvoice: typed, overrides: { stateOfSupply: "18" } });
      eq(review.step, "review");
      eq(review.bill.header.checks.filter((c) => c.level === "error").length, 0, JSON.stringify(review.bill.header.checks));

      const lost = await step(MESSAGE_TYPES.BILL_UPLOAD_CREATE, { confirmed: true, acknowledged: true });
      eq(lost.step, "review", "back on the review");
      eq(lost.error && lost.error.code, "BILL_OUTCOME_UNKNOWN");
      eq(lost.bill.unknown && lost.bill.unknown.step, "header");
      assert(/invoice 1061000262/.test(lost.bill.unknown.text) && /reloaded, closed or left/.test(lost.bill.unknown.text), lost.bill.unknown.text);
      assert(lost.bill.header.checks.some((c) => c.level === "error" && /answer did not arrive/.test(c.text)), "Create is stopped by a check");
      eq(headerSent, 1);
      assert(warnings.some((w) => /Bill upload step create stopped/.test(w) && w.includes(CHANNEL_CLOSED)), `the transport's own error is logged: ${warnings.join("\n")}`);

      const refused = await step(MESSAGE_TYPES.BILL_UPLOAD_CREATE, { confirmed: true, acknowledged: true });
      eq(refused.error && refused.error.code, "BILL_OUTCOME_UNKNOWN", "Create again is refused");
      eq(headerSent, 1, "nothing sent again");

      const u = refused.bill.unknown;
      eq((await job[MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED]({ step: u.step, at: u.at, checked: false })).ok, false, "the tick is needed");
      eq((await job[MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED]({ step: u.step, at: "2000-01-01T00:00:00.000Z", checked: true })).ok, false, "for the write the user read about");
      eq((await job[MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED]({ step: u.step, at: u.at, checked: true })).ok, true);
      const freed = await job[MESSAGE_TYPES.BILL_UPLOAD_GET_STATE]({});
      eq(freed.bill.unknown, null);
      assert(!freed.bill.header.checks.some((c) => /answer did not arrive/.test(c.text)), "the stop is gone");

      lose = false;
      const done = await step(MESSAGE_TYPES.BILL_UPLOAD_CREATE, { confirmed: true, acknowledged: true });
      eq(done.step, "done", JSON.stringify(done.error));
      eq(done.bill.billRegNo, "3744921");
      eq(headerSent, 2);

      // a worker restart in the middle of a step: the text names the step and what to check (3.13a)
      const restarted = (running, context) => {
        const s = memoryStorageArea();
        s.set({ [SESSION_KEYS.BILL_UPLOAD_STATE]: { ...done, busy: true, running, message: "Saving the bill item in IREPS...", context } });
        globalThis.chrome = { ...globalThis.chrome, storage: { session: s, local } };
        return createBillUploadJob({ broadcast: () => {}, parseSearchPo: async () => ({ records: [] }) });
      };
      const billContext = { receipt: receiptNS(), invoice: { invoiceNumber: "1061000262" }, billRegNo: "3744921", existing: null };
      const item = await restarted("item", billContext)[MESSAGE_TYPES.BILL_UPLOAD_GET_STATE]({});
      eq(item.error.code, "BILL_INTERRUPTED");
      assert(/while it was saving the item of draft bill 3744921/.test(item.error.message) && /check bill 3744921 in IREPS/.test(item.error.message), item.error.message);
      assert(!/second draft/.test(item.error.message), "the item step creates no draft");
      const header = await restarted("create", { ...billContext, billRegNo: null })[MESSAGE_TYPES.BILL_UPLOAD_GET_STATE]({});
      assert(/while it was creating the draft bill for invoice 1061000262 \(PO 40265077101806, PO Sr 001\)/.test(header.error.message) && /Bills for Pay/.test(header.error.message), header.error.message);
      const read = await restarted("prepare", null)[MESSAGE_TYPES.BILL_UPLOAD_GET_STATE]({});
      assert(/only reads IREPS and ECM/.test(read.error.message), read.error.message);
    } finally {
      globalThis.chrome = realChrome;
      console.warn = realWarn;
    }
  });

  await test("bill tab transport (3.8): the IREPS deadline ends a request the tab never answers, and the tab is told to stop it", async () => {
    const realChrome = globalThis.chrome;
    const realSetTimeout = globalThis.setTimeout;
    const sent = [];
    let finishInjection = null;
    globalThis.chrome = {
      runtime: {},
      scripting: { executeScript: async () => [{ result: null }] },
      tabs: {
        get: async (tabId) => ({ id: tabId, url: "http://localhost:8765/epsn/ct/fetchPODetails.do" }),
        sendMessage: (tabId, message) => {
          sent.push(message);
          return message.type === "DOCLINK_TAB_FETCH" ? new Promise(() => {}) : Promise.resolve();
        }
      }
    };
    try {
      // the request's own signal ends it at once
      const controller = new AbortController();
      const pending = tabFetch(9801)("http://localhost:8765/epsn/ct/populatePOSrList.do", { method: "POST", body: "rly=05", signal: controller.signal });
      await until(() => sent.some((m) => m.type === "DOCLINK_TAB_FETCH"), "the request in the tab");
      controller.abort();
      const stopped = await failureOf(pending);
      eq(stopped && stopped.name, "AbortError", String(stopped));
      const asked = sent.find((m) => m.type === "DOCLINK_TAB_FETCH");
      const cancel = sent.find((m) => m.type === "DOCLINK_TAB_ABORT");
      assert(asked.id && cancel && cancel.id === asked.id, "the tab is told which request to stop");

      // requestIreps' 120 s deadline (made to pass at once here) reaches the tab transport
      globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= IREPS_CONFIG.timeoutMs ? 0 : ms, ...args);
      const timedOut = await failureOf(requestIreps({ path: "/epsn/ct/populatePOSrList.do", method: "POST", body: "rly=05" }, { fetch: tabFetch(9801) }));
      globalThis.setTimeout = realSetTimeout;
      assert(timedOut instanceof IrepsError && timedOut.code === IREPS_ERROR.REQUEST_FAILED && timedOut.reason === "timeout", String(timedOut));
      eq(sent.filter((m) => m.type === "DOCLINK_TAB_ABORT").length, 2);

      // a deadline that passes while DocLink's script is still being injected: nothing is sent at all
      globalThis.chrome.scripting.executeScript = () => new Promise((r) => (finishInjection = () => r([{ result: null }])));
      const late = new AbortController();
      const hung = tabFetch(9802)("http://localhost:8765/epsn/ct/saveBillHeader.do", { method: "POST", body: "x=1", signal: late.signal });
      await until(() => finishInjection, "the injection");
      late.abort();
      eq((await failureOf(hung)).name, "AbortError");
      finishInjection();
      await new Promise((r) => realSetTimeout(r, 0));
      assert(!sent.some((m) => m.type === "DOCLINK_TAB_FETCH" && /saveBillHeader/.test(m.url)), "the write never left after the deadline");
    } finally {
      globalThis.chrome = realChrome;
      globalThis.setTimeout = realSetTimeout;
    }
  });

  await test("bill upload flow (5.4): the bill page (it carries a Struts token) waits for a running IREPS form sequence", async () => {
    const page = await billPage(fixture);
    const ireps = fakeBillIreps(page);
    let release;
    const held = withIrepsFormLock(() => new Promise((r) => (release = r)));
    const preparing = prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: ireps.fetchImpl, store: createBillStore(memoryStorageArea()), today: TODAY });
    await new Promise((r) => setTimeout(r, 50));
    eq(ireps.calls.length, 0, "nothing is sent while another form sequence holds the lock");
    release();
    await held;
    const ctx = await preparing;
    eq(ireps.calls[0].path, "/epsn/ct/fetchPODetails.do");
    eq(ctx.roNo, "35294-26-66158");
    eq(await withIrepsFormLock(async () => "free"), "free", "the lock is free again once the page is read");
  });

  await test("bill upload flow (3.5): a receipt IREPS does not list is stopped, never swapped for the one IREPS lists", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    const other = fakeBillIreps(page, { override: (path) => (path.endsWith("populateROList.do") ? "success^^1^^35294-26-99999" : null) });
    const deps = { fetch: other.fetchImpl, store, today: TODAY };
    const ctx = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps);
    eq(ctx.roNo, null, "not switched to the other receipt");
    assert(ctx.header.checks.some((c) => c.level === "error" && /IREPS does not list receipt 35294-26-66158 for PO Sr 001 \(it lists 35294-26-99999\)/.test(c.text)), JSON.stringify(ctx.header.checks));
    assert(!other.calls.some((c) => c.path.endsWith("populateRODetails.do")), "the other receipt is not read");
    await rejects(createDraftBill(ctx, { acknowledged: true }, deps), BILL_ERROR.CHECKS_FAILED);
    eq(other.writes().length, 0);
    const noRo = await prepareBill({ receipt: { ...receiptNS(), roNo: null }, invoice: ECM_INVOICE }, { ...deps, fetch: fakeBillIreps(page).fetchImpl });
    assert(noRo.header.checks.some((c) => c.level === "error" && /shows no RO number/.test(c.text)), JSON.stringify(noRo.header.checks));
  });

  await test("bill upload flow (3.4): an invoice DocLink billed on one receipt is refused on another", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    const deps = { fetch: fakeBillIreps(page).fetchImpl, store, today: TODAY };
    eq((await createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps), { acknowledged: true }, deps)).outcome, "item-saved");
    // another receipt of the PO, offered the same invoice (say, the typed fields were left as they were)
    const second = receiptFromCrn({ ...CRN_RECEIPT_RECORD, crnNo: "35294-26-66159" });
    const other = fakeBillIreps(page, { override: (path) => (path.endsWith("populateROList.do") ? "success^^1^^35294-26-66159" : null) });
    const deps2 = { ...deps, fetch: other.fetchImpl };
    const ctx = await prepareBill({ receipt: second, invoice: { ...ECM_INVOICE, invoiceNumber: " 1061000262 " } }, deps2);
    assert(ctx.header.checks.some((c) => c.level === "error" && /Invoice 1061000262 is already on another receipt's bill that DocLink created: draft bill 3744921/.test(c.text)), JSON.stringify(ctx.header.checks));
    await rejects(createDraftBill(ctx, { acknowledged: true }, deps2), BILL_ERROR.CHECKS_FAILED);
    eq(other.writes().length, 0, "nothing written");
    // also when the store learnt of it after the review: Create checks it again
    const store3 = createBillStore(memoryStorageArea());
    const deps3 = { ...deps2, store: store3 };
    const before = await prepareBill({ receipt: second, invoice: ECM_INVOICE }, deps3);
    eq(before.header.checks.filter((c) => c.level === "error").length, 0, JSON.stringify(before.header.checks));
    await store3.put(receiptNS().key, { invoiceNo: "1061000262", poNumber: "40265077101806", poSr: "001", roNo: "35294-26-66158", billRegNo: null, unknown: { step: "header", why: "x", at: new Date().toISOString() } });
    const refused = await rejects(createDraftBill(before, { acknowledged: true }, deps3), BILL_ERROR.CHECKS_FAILED);
    assert(/a bill whose creation IREPS has not confirmed/.test(refused.detail), refused.detail);
    eq(other.writes().length, 0);
  });

  await test("bill upload (3.3): an ECM invoice is used only when its PO, PO Sr and quantity (where it has them) are the receipt's", async () => {
    const automation = (answer) => async () => answer;
    const key = { customerPO: "40265077101806", customerPOSrNo: "001", invoiceQuantity: "15" };
    const record = (extra) => ({ invoiceNumber: "1061000262", onivla: 485776.5, ...extra });
    const otherPo = await rejects(retrieveInvoice(key, { automation: automation([record({ customerPONumber: "11260000100001", customerPOSrNumber: "001", quantity: 15 })]) }), BILL_ERROR.ECM_MISMATCH);
    assert(/PO 11260000100001, the receipt's is 40265077101806/.test(otherPo.detail), otherPo.detail);
    await rejects(retrieveInvoice(key, { automation: automation([record({ customerPONumber: "40265077101806", customerPOSrNumber: "002" })]) }), BILL_ERROR.ECM_MISMATCH, "PO Sr");
    await rejects(retrieveInvoice(key, { automation: automation([record({ quantity: "14" })]) }), BILL_ERROR.ECM_MISMATCH, "quantity");
    // a record of another receipt next to this receipt's: this receipt's is used, without ambiguity
    const mixed = await retrieveInvoice(key, { automation: automation([record({ invoiceNumber: "OTHER", customerPOSrNumber: "002" }), record({ customerPONumber: "40265077101806", customerPOSrNumber: "1", quantity: "15.0" })]) });
    eq(mixed.invoiceNumber, "1061000262", "numbers compare by value, as in a JSON file");
    // what ECM does not answer is not checked (it has no PO Sr yet)
    eq((await retrieveInvoice(key, { automation: automation([record({})]) })).invoiceNumber, "1061000262");
    eq(receiptMismatches({ customerPONumber: "40265077101806" }, key).length, 0);
    eq(describeError(BILL_ERROR.ECM_MISMATCH, { detail: "x" }).code, "BILL_ECM_MISMATCH");
  });

  await test("bill upload (3.2): the railway GSTIN is one IREPS offers for the state of supply; when no single one fits, the item stops", () => {
    const list = [
      { value: "18AAAGM0289C1ZI", label: "18AAAGM0289C1ZI-Assam" },
      { value: "18AAACI0681C1ZY", label: "18AAACI0681C1ZY-~Assam-IRFC" },
      { value: "29AAAGM0289C1ZF", label: "29AAAGM0289C1ZF-Karnataka" },
      { value: "29AAACI0681C1ZV", label: "29AAACI0681C1ZV-~Karnataka-IRFC" },
      { value: "11AAAGM0289C1ZW", label: "11AAAGM0289C1ZW-Sikkim" }
    ];
    const pick = (consigneeGstin, stateOfSupply, railwayGstins = list) => railwayGstinFor({ consigneeGstin, stateOfSupply, supplierState: "06", railwayGstins });
    const same = pick("18AAAGM0289C1ZI", "18");
    eq(same.value, "18AAAGM0289C1ZI", "the consignee's own when it is of the state of supply");
    eq(same.checks.length, 0);
    // the stock capture (HAR #113 / #116): consignee 37AAAGM0289C1ZI, state of supply 29, IREPS saved 29AAAGM0289C1ZF
    const captured = pick("37AAAGM0289C1ZI", "29");
    eq(captured.value, "29AAAGM0289C1ZF");
    eq(captured.checks.map((c) => c.level).join(), "warning", "shown, and to be acknowledged");
    eq(pick("37AAACI0681C1ZY", "29").value, "29AAACI0681C1ZV", "an IRFC consignee keeps IRFC's GSTIN");
    eq(pick("37AAACI0681C1ZY", "11").value, "11AAAGM0289C1ZW", "the only one IREPS offers for that state");
    const none = pick("37AAAGM0289C1ZI", "33");
    eq(none.value, "");
    assert(none.checks[0].level === "error" && /it offers none/.test(none.checks[0].text) && /Save the item in IREPS yourself/.test(none.checks[0].text), JSON.stringify(none.checks));
    const two = pick("37AAAAA0000A1Z5", "29");
    eq(two.value, "");
    assert(two.checks[0].level === "error" && /it offers 29AAAGM0289C1ZF, 29AAACI0681C1ZV/.test(two.checks[0].text), JSON.stringify(two.checks));
    eq(pick(null, "18").checks[0].level, "error", "no consignee GSTIN");
    eq(pick("18AAAAA0000A1Z5", "18").checks[0].level, "error", "of the state, but not in IREPS's list");
  });

  await test("bill upload panel (3.1, 3.4): ticks are cleared after a failed step, a typed invoice is not offered for another receipt, a lost answer stops Create", async () => {
    const doc = new DOMParser().parseFromString(await fixture("../../popup/popup.html"), "text/html");
    const view = document.importNode(doc.getElementById("view-upload"), true);
    const opener = document.createElement("button");
    opener.id = "btn-upload";
    document.body.append(view, opener);
    const sent = [];
    let current = null;
    const ctx = {
      send: async (type, payload) => (sent.push({ type, payload }), type === MESSAGE_TYPES.BILL_UPLOAD_GET_STATE ? current : { started: true, ok: true }),
      showView: () => {},
      setConnection: () => {},
      setConnectionForError: () => {},
      currentPanelTabId: async () => 7
    };
    const show = (s) => {
      current = s;
      handleBillUploadMessage({ type: MESSAGE_TYPES.BILL_UPLOAD_UPDATE, state: s });
    };
    const $ = (id) => document.getElementById(id);
    try {
      initBillUpload(ctx);
      const rA = receiptNS();
      const rB = { ...receiptFromCrn({ ...CRN_RECEIPT_RECORD, crnNo: "35294-26-66159" }) };
      const base = { step: "receipts", busy: false, message: "", poNo: rA.poNo, receipts: [rA, rB], warnings: [], receiptKey: null, invoiceMode: "manual", invoice: null, bill: null, documents: null, docUpload: null, documentTypes: [], error: null };
      show(base);
      const radio = (key) => Array.from(view.querySelectorAll('input[name="bill-receipt"]')).find((r) => r.value === key);
      const choose = (key) => {
        radio(key).checked = true;
        radio(key).dispatchEvent(new Event("change"));
      };
      const type = (id, value) => {
        $(id).value = value;
        $(id).dispatchEvent(new Event("input", { bubbles: true }));
      };
      // 3.4: an invoice typed for receipt A is emptied when receipt B is chosen
      choose(rA.key);
      type("bill-inv-number", "1061000262");
      type("bill-inv-amount", "485776.5");
      choose(rA.key);
      eq($("bill-inv-number").value, "1061000262", "the same receipt keeps it");
      choose(rB.key);
      eq($("bill-inv-number").value, "", "another receipt starts empty");
      eq($("bill-inv-amount").value, "");

      // 3.1: the ticks given for a Create that failed are cleared
      const header = { review: [], checks: [] };
      const reviewState = { ...base, step: "review", receiptKey: rA.key, bill: { receipt: rA, header, item: null, billRegNo: null, dispatchNo: null, existing: null, unknown: null, documentsOnBill: null, forgottenBills: [] } };
      show(reviewState);
      $("bill-confirm").checked = true;
      $("bill-confirm").dispatchEvent(new Event("change"));
      eq($("btn-bill-create").disabled, false, "Create can be clicked once the values are confirmed");
      show({ ...reviewState, busy: true, message: "Creating the draft bill in IREPS..." });
      const unknown = { step: "header", at: "2026-11-24T11:02:00.000Z", text: "On 24/11/2026 16:32 DocLink sent the bill header ...", confirm: "I checked the PO's Bills for Pay in IREPS: there is no draft bill for invoice 1061000262.", button: "Allow creating the bill again" };
      const stopped = { ...reviewState, error: describeError("BILL_OUTCOME_UNKNOWN", { detail: unknown.text }), bill: { ...reviewState.bill, header: { review: [], checks: [{ level: "error", text: unknown.text }] }, existing: { billRegNo: null, unknown }, unknown } };
      show(stopped);
      eq($("bill-confirm").checked, false, "the confirmation is given again after a failed write");
      eq($("btn-bill-create").disabled, true, "Create stays stopped");
      eq($("bill-forget").hidden, true, "Start fresh is not offered for it");
      // the box says what to check and frees the step only with its own tick
      const box = Array.from(view.querySelectorAll(".bill-forget")).find((b) => b.id !== "bill-forget");
      assert(box && !box.hidden && box.textContent.includes("there is no draft bill for invoice 1061000262"), box && box.textContent);
      const [tick] = box.querySelectorAll("input[type=checkbox]");
      const free = box.querySelector("button");
      eq(free.disabled, true);
      tick.checked = true;
      tick.dispatchEvent(new Event("change"));
      eq(free.disabled, false);
      free.click();
      await until(() => sent.some((m) => m.type === MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED), "the confirmation");
      const confirmation = sent.find((m) => m.type === MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED).payload;
      eq(JSON.stringify([confirmation.step, confirmation.at, confirmation.checked]), JSON.stringify(["header", unknown.at, true]));

      // 3.4: once a draft bill exists, the typed invoice is emptied
      type("bill-inv-number", "1061000262");
      show({ ...reviewState, step: "done", bill: { ...reviewState.bill, billRegNo: "3744921", dispatchNo: "3894570", existing: { billRegNo: "3744921", status: "item-saved", unknown: null } } });
      eq($("bill-inv-number").value, "", "emptied after the bill was created");
    } finally {
      view.remove();
      opener.remove();
    }
  });

  /* ------------------------------------------------- inspection of 24 Nov 2026, round 2: 3.9 to 3.13 */

  /**
   * What the bill page itself sends for a Final GST item without PVC, discount or charges, on its own
   * string fields: billFunctions.js calcBBR and calculateExpAmt as captured (HAR #77), transcribed.
   */
  const pageItemAmounts = ({ poRate, roQty, igstRate, cgstRate, sgstRate, utgstRate, payPC = "100" }) => {
    const basicBillRate = parseFloat(String(parseFloat((parseFloat(poRate) + parseFloat("0")).toFixed(5))));
    const taxableAmt = (basicBillRate * roQty * payPC) / 100;
    const gst = (rate) => parseFloat(((taxableAmt * rate) / 100).toFixed(2));
    const [igstAmt, cgstAmt, sgstAmt, utgstAmt, cessAmt] = [gst(igstRate), gst(cgstRate), gst(sgstRate), gst(utgstRate), gst("0")];
    const taxAmt = cgstAmt + sgstAmt + utgstAmt + igstAmt + cessAmt;
    return {
      netBasicRate: String(basicBillRate),
      expenseAmount: taxableAmt.toFixed(2),
      basicAmount: taxAmt.toFixed(2),
      totalAmount: (taxableAmt + taxAmt).toFixed(2),
      igstAmount: String(igstAmt),
      cgstAmount: String(cgstAmt),
      sgstAmount: String(sgstAmt),
      utgstAmount: String(utgstAmt)
    };
  };

  await test("bill upload (3.9): every item amount is the bill page's own to the paisa, also for PO rates with paise", () => {
    // a half paisa: 595437.75 x 18 / 100 = 107178.795, which the page's toFixed(2) rounds down
    const igst = computeAmounts({ rate: 39695.85, qty: 15, gstRate: 18, supplierState: "33", stateOfSupply: "09" });
    eq(JSON.stringify([igst.taxable, igst.igst, igst.tax, igst.total]), JSON.stringify([595437.75, 107178.79, 107178.79, 702616.54]));
    const halves = computeAmounts({ rate: 23857.11, qty: 250, gstRate: 18, supplierState: "33", stateOfSupply: "33" });
    eq(JSON.stringify([halves.cgst, halves.sgst, halves.tax, halves.total]), JSON.stringify([536784.97, 536784.97, 1073569.94, 7037847.44]));
    const five = computeAmounts({ rate: 8019.37, qty: 100, gstRate: 5, supplierState: "33", stateOfSupply: "33" });
    eq(JSON.stringify([five.cgst, five.total]), JSON.stringify([20048.42, 842033.84]), "2.5% CGST + 2.5% SGST");
    eq(pageRound2(1.005), 1, "the page's rounding of the binary value");
    eq(round2(1.005), 1.01, "round2 stays for the values DocLink picks itself");

    // a sweep: paise and integer rates, a rate with more than 5 decimals, part quantities, IGST / CGST+SGST / UTGST
    const rateText = (n) => String(round2(n));
    const fields = ["netBasicRate", "expenseAmount", "basicAmount", "totalAmount", "igstAmount", "cgstAmount", "sgstAmount", "utgstAmount"];
    let compared = 0;
    const differ = [];
    for (const gstRate of [18, 5, 12, 28, 3, 8.9, 13.8, 40]) {
      for (const [supplierState, stateOfSupply] of [["33", "09"], ["33", "33"], ["04", "04"]]) {
        for (let i = 0; i < 60; i++) {
          const paise = (i * 37) % 100;
          const rupees = 1 + ((i * 7919) % 99000);
          const text = paise ? `${rupees}.${String(paise).padStart(2, "0")}` : String(rupees);
          for (const poRate of [text, String(Number(text) / 7)]) {
            for (const roQty of ["1", "3", "15", "87", "250", "2.5", "1234.567"]) {
              const a = computeAmounts({ rate: Number(poRate), qty: Number(roQty), gstRate, supplierState, stateOfSupply });
              const page = pageItemAmounts({ poRate, roQty, igstRate: rateText(a.split.igst), cgstRate: rateText(a.split.cgst), sgstRate: rateText(a.split.sgst), utgstRate: rateText(a.split.utgst) });
              const ours = { netBasicRate: String(a.basicRate), expenseAmount: a.taxable.toFixed(2), basicAmount: a.tax.toFixed(2), totalAmount: a.total.toFixed(2), igstAmount: String(a.igst), cgstAmount: String(a.cgst), sgstAmount: String(a.sgst), utgstAmount: String(a.utgst) };
              compared++;
              const bad = fields.filter((k) => ours[k] !== page[k]);
              if (bad.length && differ.length < 3) differ.push(`${poRate} x ${roQty} at ${gstRate}% (${supplierState}->${stateOfSupply}): ${bad.map((k) => `${k} ${ours[k]}, the page ${page[k]}`).join("; ")}`);
            }
          }
        }
      }
    }
    assert(compared > 5000, `compared ${compared}`);
    eq(differ.length, 0, differ.join(" | "));

    // the item body: amounts, the basic rate as the page holds it, the max claim compared as the page does
    const item = (poRate) => parseItemDetails(NS.item.replace("^^27445^^", `^^${poRate}^^`));
    const ro = (value, maxClaim = value) => parseRoDetails(`success^^04/09/2026^^15^^Not Applicable^^0^^Not Applicable^^Not Applicable^^0^^NA^^^^15.0^^^^${value}^^0^^${maxClaim}^^http://www.ireps.gov.in/x.pdf`);
    const input = { header: { ...NS_HEADER, invoiceAmount: "702616.54" }, billRegNo: "3744921", receipt: receiptFromCrn(CRN_RECEIPT_RECORD), roNo: "35294-26-66158", railwayGstins: [{ value: "18AAAGM0289C1ZI" }] };
    const paise = buildItem({ ...input, invoice: { ...ECM_INVOICE, amount: 702616.54 }, item: item("39695.85"), ro: ro("702616.54") });
    eq(paise.checks.length, 0, JSON.stringify(paise.checks));
    const sent = Object.fromEntries(new URLSearchParams(orderedBody(SAVE_DETAILS_FIELDS, paise.values)));
    eq(JSON.stringify([sent.poRate, sent.netBasicRate, sent.expenseAmount, sent.basicAmount, sent.totalAmount, sent.igstAmount, sent.maxClaim]), JSON.stringify(["39695.85", "39695.85", "595437.75", "107178.79", "702616.54", "107178.79", "702616.54"]));
    const trailing = buildItem({ ...input, header: { ...NS_HEADER, invoiceAmount: "4370.13" }, invoice: { ...ECM_INVOICE, amount: 4370.13 }, item: item("1234.50"), ro: ro("4370.13") });
    eq(trailing.values.poRate, "1234.50", "the PO rate as IREPS gave it");
    eq(trailing.values.netBasicRate, "1234.5", "the page's basicBillRate is a number");
    // the page compares whole rupees of its two-decimal max claim: 485776.4951 is 485776.50, so 485777 is not more
    const nearHalf = buildItem({ ...input, header: NS_HEADER, invoice: ECM_INVOICE, item: parseItemDetails(NS.item), ro: ro("485776.5", "485776.4951") });
    eq(nearHalf.values.maxClaim, "485776.4951", "kept, as the page keeps it");
    // the captured bills are unchanged (also byte for byte: the non-stock item test above)
    eq(computeAmounts({ rate: 7916, qty: 87, gstRate: 18, supplierState: "06", stateOfSupply: "37" }).total, 812656.56);
  });

  await test("bill upload (3.10): an ISO time with its zone gives the IST day; a number that is not epoch ms is refused, never a 1970 date", async () => {
    eq(invoiceDateToIreps("2026-10-29T23:00:00.000Z"), "30/10/2026", "Nuxeo's midnight 30 Oct in UTC+1");
    eq(invoiceDateToIreps("2026-08-17T18:30:00.000Z"), "18/08/2026", "midnight in IST");
    eq(invoiceDateToIreps("2026-08-18T00:00:00.000+05:30"), "18/08/2026");
    eq(invoiceDateToIreps("2026-10-30T00:00:00+01:00"), "30/10/2026");
    eq(invoiceDateToIreps("2026-08-18T23:59:59-0400"), "19/08/2026");
    eq(invoiceDateToIreps("2026-08-18 00:00:00.000"), "18/08/2026", "without a zone the day is the one written");
    eq(invoiceDateToIreps("2026-08-18T10:00:00"), "18/08/2026");
    eq(invoiceDateToIreps("2026-02-30T10:00:00Z"), null);
    eq(invoiceDateToIreps("2026-08-18T25:00:00Z"), null, "not a real time");
    eq(invoiceDateToIreps("2026-08-18T10:00:00+05:75"), null, "not a real zone");
    eq(invoiceDateToIreps(1793314800000), "30/10/2026", "epoch ms as before");
    eq(invoiceDateToIreps("1793314800000"), "30/10/2026");
    for (const notMs of [20261030, "20261030", 1793314800, "1793314800", -1, 0.5, 1793314800000.5, 99999999999999]) eq(invoiceDateToIreps(notMs), null, `${notMs} is no date`);

    const form = parseBillForm(await billPage(fixture));
    const header = (invoiceDate) => buildHeader({ receipt: receiptFromCrn(CRN_RECEIPT_RECORD), invoice: { ...ECM_INVOICE, invoiceDate }, form, payAuths: parsePayAuthList(NS.payAuth), stockNonstock: "N", today: TODAY });
    const refused = header(20261030);
    eq(refused.values.invoiceDate, "", "no date is sent");
    const text = refused.checks.filter((c) => c.level === "error").map((c) => c.text).join(" | ");
    assert(text.includes(invoiceDateRefusal(20261030)) && /"20261030" is a number, but not a date in milliseconds/.test(text), text);
    assert(!JSON.stringify(refused).includes("1970"), "never a day in 1970");
    eq(header("2026-10-29T23:00:00.000Z").values.invoiceDate, "30/10/2026");
    eq(invoiceDateRefusal("2026-13-01"), 'Invoice date "2026-13-01" is not a date.');
  });

  await test("document upload (3.11): a '~' in the file name stays in the registered filePath; the path is the bill page's, checked against save.php", async () => {
    const saved = parseSaveResult("<html><body onload='window.parent.CRISPKI.afterUpload()'>OK~ireps/upload/billDocuments/112026/3744921/3894570/INV~2026~A.pdf~1234</body></html>");
    eq(saved.path, "ireps/upload/billDocuments/112026/3744921/3894570/INV~2026~A.pdf");
    eq(saved.bytes, 1234);
    await rejects(Promise.resolve().then(() => parseSaveResult("<html><body>OK~ireps/upload/x.pdf</body></html>")), BILL_ERROR.IREPS_REJECTED, "no size: the page says 'Document not saved!'");
    await rejects(Promise.resolve().then(() => parseSaveResult("<html><body>OK~ireps/upload/x.pdf~0</body></html>")), BILL_ERROR.IREPS_REJECTED, "size 0");

    const bill = { billRegNo: "3744921", dispatchNo: "3894570", vendorCode: ":833", thumbprint: THUMB, spmBillRegNo: "null" };
    const run = async (name, answer) => {
      const calls = [];
      const deps = {
        today: new Date(2026, 8, 15),
        signPdf: async () => signerReply(),
        saveFile: async (form) => (calls.push({ save: form }), answer(form)),
        fetch: async (url, init) => (calls.push({ url: String(url), body: init.body }), new Response("OK#1<>x.pdf#ireps/x.pdf#INVOICE#15/09/2026 16:42#USER#1<>", { status: 200 }))
      };
      const out = await failureOf(uploadBillDocument({ bill, file: { name, base64: PDF_B64 }, fileDesc: "GUARANTEE WARRANTY CERTIFICATE" }, deps));
      const registered = calls.find((c) => c.url);
      return { out, save: calls[0] && calls[0].save, registered: registered ? new URLSearchParams(registered.body) : null };
    };
    // the non-stock capture (3_GENERATEPDF.txt, the guarantee / warranty certificate): save.php's answer
    // and the filePath IREPS's page registered with it
    const captured = await run("1061000262 - GARRANTYWARRANTYCERTIFICATE.pdf", () => "<html><body onload='window.parent.CRISPKI.afterUpload()'>OK~ireps/upload/billDocuments/092026/3744921/3894570/1061000262-GARRANTYWARRANTYCERTIFICATE.pdf~113626</body></html>");
    eq(captured.out, null, captured.out && captured.out.detail);
    eq(captured.registered.get("filePath"), "ireps/upload/billDocuments/092026/3744921/3894570/1061000262-GARRANTYWARRANTYCERTIFICATE.pdf");
    // a "~" in the name: the whole name is registered
    const tilde = await run("INV~2026.pdf", (form) => `<html><body onload='window.parent.CRISPKI.afterUpload()'>OK~${form.relativeDir}/${form.pdfName}~37233</body></html>`);
    eq(tilde.save.pdfName, "INV~2026.pdf");
    eq(tilde.registered.get("filePath"), "ireps/upload/billDocuments/092026/3744921/3894570/INV~2026.pdf");
    // IREPS stored it under another name: nothing is registered
    const elsewhere = await run("INV~2026.pdf", (form) => `<html><body>OK~${form.relativeDir}/INV2026.pdf~37233</body></html>`);
    eq(elsewhere.out && elsewhere.out.code, BILL_ERROR.RESPONSE_INVALID);
    assert(/stored the file as .*INV2026\.pdf, not as .*INV~2026\.pdf/.test(elsewhere.out.detail), elsewhere.out.detail);
    eq(elsewhere.registered, null, "uploadBillDocuments.do is not sent");
  });

  await test("bill upload flow (3.12): a PO Sr list IREPS did not answer stops as itself; a refusal is shown in IREPS's words; neither switches Stock / Non-Stock", async () => {
    const page = await billPage(fixture);
    const store = createBillStore(memoryStorageArea());
    // the CRN suggests Non-Stock; IREPS would list PO Sr 001 under Stock
    const portal = (nonStock, stock = "success^^001") =>
      fakeBillIreps(page, { override: (path, body) => (path.endsWith("populatePOSrList.do") ? (new URLSearchParams(body).get("stockNonstock") === "N" ? nonStock() : stock) : null) });
    const prepare = (ireps) => prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, { fetch: ireps.fetchImpl, store, today: TODAY });

    const lost = await failureOf(prepare(portal(() => new TypeError("Failed to fetch"))));
    eq(lost && lost.code, BILL_ERROR.REQUEST_FAILED, "the step stops: IREPS did not answer");
    assert(/populatePOSrList/.test(lost.detail), lost.detail);
    const late = await failureOf(prepare(portal(() => new DOMException("The operation was aborted.", "AbortError"))));
    eq(late && late.code, BILL_ERROR.REQUEST_FAILED);
    assert(/did not answer within/.test(late.detail), late.detail);
    const loginPage = await fixture("login-page.html");
    await rejects(prepare(portal(() => loginPage)), IREPS_ERROR.SESSION_EXPIRED, "IREPS's login page is a logout, not a list");

    const ireps = portal(() => "Server is busy. Please try after some time.");
    const refused = await prepare(ireps);
    eq(refused.stockNonstock, "N", "not switched to Stock");
    const errors = refused.header.checks.filter((c) => c.level === "error").map((c) => c.text);
    assert(errors.some((t) => /did not give the Non-Stock PO Sr list/.test(t) && t.includes('"Server is busy. Please try after some time."')), JSON.stringify(errors));
    assert(!refused.header.checks.some((c) => /lists no PO Sr|DocLink uses Stock/.test(c.text)), JSON.stringify(refused.header.checks));
    eq(ireps.calls.filter((c) => c.path.endsWith("populatePOSrList.do")).length, 1, "the other list is not asked for");
    await rejects(createDraftBill(refused, { acknowledged: true }, { fetch: ireps.fetchImpl, store, today: TODAY }), BILL_ERROR.CHECKS_FAILED);
    eq(ireps.writes().length, 0);

    // Non-Stock lists none, Stock is refused: no switch either
    const other = await prepare(portal(() => "success", "Invalid Paying Authority"));
    eq(other.stockNonstock, "N");
    assert(other.header.checks.some((c) => c.level === "error" && /lists no PO Sr 001 under Non-Stock \(none\), and did not give the Stock list; it answered "Invalid Paying Authority"/.test(c.text)), JSON.stringify(other.header.checks));
  });

  await test("bill upload flow (3.13): populateRODetails 'duplicate' and 'multi' say what IREPS means, in the review and at the item", async () => {
    const page = await billPage(fixture);
    for (const [answer, says] of [["duplicate", /already on another bill in IREPS/], ["multi^^", /takes a CRN only once in a bill, and any balance of it only on a separate bill/]]) {
      const store = createBillStore(memoryStorageArea());
      const ireps = fakeBillIreps(page, { override: (path) => (path.endsWith("populateRODetails.do") ? answer : null) });
      const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
      const ctx = await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps);
      const stop = ctx.header.checks.find((c) => c.level === "error" && says.test(c.text));
      assert(stop, JSON.stringify(ctx.header.checks));
      assert(stop.text.includes(RO_REFUSALS[answer.split("^^")[0]]) && stop.text.includes("receipt 35294-26-66158") && /Bills for Pay/.test(stop.text), stop.text);
      assert(!/populateRODetails/.test(stop.text), "not IREPS's raw answer");
      await rejects(createDraftBill(ctx, { acknowledged: true }, deps), BILL_ERROR.CHECKS_FAILED);
      eq(ireps.writes().length, 0, "nothing written");
    }
    // at the item (after the draft bill was created): the item stops with the same text, nothing more is written
    const store = createBillStore(memoryStorageArea());
    let reads = 0;
    const ireps = fakeBillIreps(page, { override: (path) => (path.endsWith("populateRODetails.do") && ++reads > 1 ? "duplicate" : null) });
    const deps = { fetch: ireps.fetchImpl, store, today: TODAY };
    const created = await createDraftBill(await prepareBill({ receipt: receiptNS(), invoice: ECM_INVOICE }, deps), { acknowledged: true }, deps);
    eq(created.outcome, "item-blocked");
    assert(created.context.item.checks.some((c) => c.level === "error" && c.text.includes(RO_REFUSALS.duplicate)), JSON.stringify(created.context.item.checks));
    eq(ireps.writes().length, 1, "the header only");
    // the code itself has a text too (if it ever reaches the panel)
    const error = await failureOf(Promise.resolve().then(() => parseRoDetails("multi", "013809-26-20009")));
    eq(error && error.code, BILL_ERROR.RECEIPT_REFUSED);
    assert(/CRN only once in a bill/.test(describeError(error.code, { detail: error.detail }).message), "described");
  });
}
