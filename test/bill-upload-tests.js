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
  successFields
} from "../services/bill-upload/bill-upload-api.js";
import { parseBillForm, hasBillForm } from "../services/bill-upload/bill-form.js";
import {
  buildHeader,
  buildItem,
  computeAmounts,
  gstSplit,
  toIrepsDate,
  stateCodeOf,
  deriveStateOfSupply,
  deriveSupplierGstin,
  paymentPercentFrom,
  precheckReceipt
} from "../services/bill-upload/bill-rules.js";
import { normaliseInvoice, invoiceRecords, retrieveInvoice, manualInvoice, isSentToDoculink, billDocumentsQuery, BILL_DOCUMENTS, MAX_DOCUMENT_BYTES } from "../services/bill-upload/ecm-invoice.js";
import { createBillStore, memoryStorageArea } from "../services/bill-upload/bill-upload-store.js";
import {
  receiptFromRnote,
  receiptFromCrn,
  findBillableReceipts,
  prepareBill,
  reviewBill,
  createDraftBill,
  saveItem,
  collectBillDocuments,
  documentNeed
} from "../services/bill-upload/bill-upload-service.js";
import { callEcmAutomation, resetEcmDirectState } from "../services/ecm-direct.js";
import { applyEcmConfig } from "../services/ecm-config.js";
import { IrepsError, IREPS_ERROR, loadIrepsConfig } from "../services/ireps-api.js";
import { describeError, ERROR_CATALOG } from "../utils/messages.js";

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
 * every call. `override(path, body)` may answer a call itself.
 */
function fakeBillIreps(page, { override, billRegNo = "3744921" } = {}) {
  const calls = [];
  const answer = (text) => new Response(text, { status: 200, headers: { "content-type": "text/html;charset=UTF-8" } });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body == null ? "" : String(init.body);
    calls.push({ path, body, headers: init.headers || {} });
    const own = override && override(path, body);
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
    eq(toIrepsDate("2026-08-18 00:00:00.000"), "18/08/2026");
    eq(toIrepsDate("2026-08-18"), "18/08/2026");
    eq(toIrepsDate("8/9/2026"), "08/09/2026");
    eq(toIrepsDate("18-Aug-2026"), "18/08/2026");
    eq(toIrepsDate("31/02/2026"), null);
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
    const otherState = buildItem({ ...input, header: { ...NS_HEADER, stateOfSupply: "29" } });
    assert(otherState.checks.some((c) => c.level === "warning" && /consignee is in state 18/.test(c.text)), "consignee warning");
    eq(otherState.values.igstRate, "18", "IGST as the saved header says");
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
    assert(first.context.item.checks.some((c) => /consignee is in state 29/.test(c.text)));
    eq((await store.get(receiptNS().key)).status, "header-saved");
    const second = await saveItem(first.context, { acknowledged: true }, deps);
    eq(second.outcome, "item-saved");
    eq(ireps.writes().length, 2);
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

  await test("bill upload: every BILL_* error code has a user text", () => {
    for (const code of Object.values(BILL_ERROR)) {
      assert(ERROR_CATALOG[code], `no catalogue entry for ${code}`);
      eq(describeError(code, { detail: "x" }).code, code);
    }
  });
}
