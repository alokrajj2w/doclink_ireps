# IREPS Supplier Bill Submission — API Study for DocLink Upload

What IREPS does when a vendor submits a supplier bill (spec: "Bill Upload"),
which HTTP calls carry each step, where each input value comes from (IREPS,
ECM, a constant or a calculation), and how much of it DocLink can fill
automatically.

DocLink implements it as **Upload Bill to IREPS** (section 11; README section
20). This document is the study behind it.

---

## 1. Sources

All capture files are local and live under `01_api_data/`, which is
git-ignored. The HAR captures contain session cookies, so do not commit or
share them.

| Source | What it holds |
|---|---|
| `TSG India Doculink  ECM specifications.xlsx` → **Bill Upload** | The 13-step manual flow and 29 first-screen fields, with source (ECM / Defaulted / System / Manual) and comments |
| Same workbook → **Meta data from ECM Bill upload** | The two J2W→ECM API calls (`RetrieveInvoiceData`, `GetAttachmentFromInvoice`), ECM fields present / missing with the names of the new columns, the ECM document type and NXQL query for each bill document, Hosur/Rohtak folder ids (TST and PRD) |
| Same workbook → **Oracle data available in ECM** | The 43 invoice columns ECM already holds (32 sample rows), plus the new `Sent to Doculink` column |
| Same workbook → **Open Points**, **Downloads**, **Mohans mapping** | Open questions; document sizes and monthly volumes; how each document reaches ECM |
| `Ireps_screen_upload.xlsx` | Bill-submission team's answers: the 13 steps, documents per inspection type, volumes, re-upload cases, IREPS limits |
| `BILL SUBMISSION-Screen shot of IREPS.docx` | 12 screens (15 images) of the manual flow, Step 1 → Step 13, plus the file-size rule. Screens 3–10 follow one real Hosur bill (PO 57251305100639, invoice 3320260101270). Screen 11 is a different bill (TPI, CGST+SGST, 7 documents). |
| `DocLink Docs/Upload/3_GENERATEPDF.txt` (HAR, 21 MB) | **Complete non-stock bill**: PO search → bill header → item → 5 document uploads → preview → sign & submit. PO 40265077101806, CRN 35294-26-66158, invoice 1061000262, bill reg 3744921 |
| `upload_flow_before_uploading_file.har` (HAR, 4 MB) | **Stock bill up to the item save**: R-NOTE search → bill header → item. PO 02261018101611, R-Note 4826100504, bill reg 3816672. Stops before document upload. Also holds the page script `billFunctions.js` (#77) that computes the item amounts. |
| `DocLink Docs/Upload/1_savebillheader.txt`, `www.ireps.gov.in.har`, `generatepdf.txt` | Subsets of the above (header save for bill 3744921; preview/sign for bill 3736795; a curl of `generatePDF.do`) |
| `DocLink Docs/Download/crn_BILLSTATUS_MA.txt` | A full CRN search result (entry #293, 2,023 rows) |
| `DocLink_API_Response_Doc.xlsx` → **Upload** | Which document uploads were seen in the captures |

Entry numbers below (`#113` etc.) are HAR entry numbers as printed by
`har_inspect.py list`. They refer to the stock-bill capture unless marked
"(non-stock)".

The evidence covers **one stock bill and one non-stock bill, each a single PO
line with one receipt**, both inter-state (IGST). The screenshots add one
same-state (CGST+SGST) TPI bill, but no HTTP capture of it. Multi-line POs,
several receipts on one PO Sr, advance/retrofit bills and multi-invoice bills
have not been captured.

**Scope (bill-submission team):** 25–30 bills a day, 10–12 minutes each, one
person. A consignee-inspection bill carries 6 documents and a third-party
inspection (TPI) bill 7. Bills are re-submitted for stage payments and
returned bills (about 75 returned bills a month, Downloads sheet).

---

## 2. Summary

| Spec step | Can DocLink automate it? |
|---|---|
| 1. Check R-Note / CRN availability | **Yes**, using IREPS search calls DocLink already makes |
| 2–3. Download / collect documents | Not required (spec). The documents come from ECM in step 9. |
| 4. Match with ECM, open the bill form | **IREPS side yes.** The ECM call `RetrieveInvoiceData` is specified, but it needs the customer PO Sr no., which ECM does not store yet. |
| 5. Bill header | **Mostly.** Supplier GSTIN and state of supply are not ECM columns yet, but both can be derived from existing ECM columns once the business confirms the rule (section 8). |
| 6. Select PO Sr | **Yes** |
| 7. Billing details | **Yes.** HSN and the claim value come from ECM; everything else comes from IREPS or is calculated. |
| 8. R-Note / CRN auto-attached | **Yes**, IREPS does it |
| 9. Upload supporting documents | **Partly.** DocLink can fetch the files from ECM (`GetAttachmentFromInvoice`) and prepare them. Each file must still be picked and signed in the IREPS signing app (manual). |
| 10. Generate preview | Yes (read-only) |
| 11–13. Sign & submit | **Manual** (decision: signing stays manual) |

Data gaps, in order of impact:

1. **Customer PO Sr no.** (ECM column `customerPOSrNumber`, not present). It
   is part of the ECM match key, so the match cannot run without it.
   Workaround: match on invoice number through the IREPS challan number
   (section 6, step 4).
2. **Supplier GSTIN** (`gstinSupplier`, not present). It can probably be
   derived from ECM `division`: `WABHSR` → Hosur `33AAGCS8525B1ZL`, `WABRTK`
   → Rohtak `06AAGCS8525B1ZI` (section 8).
3. **State of supply** (not in the spec, not an ECM column). It can probably
   be derived from ECM `gstinRecipient` or the consignee address. Place of
   supply can come from ECM `supplyPlace` (section 8).
4. **Payment %** (`paymentTerm`, not present). Default 100 / Final covers
   normal bills. Advance and retrofit bills remain open.

---

## 3. Action items found during the study

- **A real draft bill was created on live IREPS while capturing.** Bill reg
  **3816672**: PO 02261018101611, PO Sr 001, R-Note 4826100504, test values
  (invoice no. `123456`, amount `1000000`, HSN `2345243`, state of supply
  Karnataka). It claims the full 87 Set. It was not signed, so it is not
  submitted, but it should be deleted from *Bills for Pay* before the real bill
  for that R-Note is raised.
- **Fixed:** the DocLink R-NOTE parser mapped the `RNOTE Qty` column to the
  R-Note number. In `services/rnote/rnote-parser.js`,
  `matchRnoteHeader("RNOTE Qty")` returns `"rnoteNo"`: the label normalises
  to `rnoteqty`, the fallback regex finds "no" inside "rnote", and the
  quantity overwrites the real R-Note number. `RO No.`, `RO Date`, `DRR No.`
  and `Bill Claim` returned `null` (not mapped). Now mapped, with the Bill
  Claim link's `rly` / `poKey` and a draft bill's reg no. kept
  (`services/rnote/rnote-parser.js`, fixture `rnote-results-real.html`).
- **The spec labels supplier GSTIN as `gstinRecipient`** (Bill Upload row 29,
  "Starts with HOSUR from 33 and for ROHTAK it is 06?"). ECM `gstinRecipient`
  is the **customer's** GSTIN (`29AAACB4881D1ZQ` for BMRCL, `URD` for exports
  in the sample rows). Do not use it as the supplier GSTIN.

---

## 4. End-to-end flow

```
A. Find billable receipts (IREPS, read-only)
   POST /epsn/searchPO.do            searchCriteria=RNOTE  and  searchCriteria=CRN
     └─ each billable row: PO no, PO_SR, qty, RO/CRN no, Bill Claim link → rly, poKey

B. Match with ECM (J2W → ECM, Nuxeo automation, Bearer token)
   POST <ECM>/nuxeo/site/api/v1/automation/RetrieveInvoiceData
        {customerPO, customerPOSrNo, invoiceQuantity}       → exactly one invoice, else stop
   POST <ECM>/nuxeo/site/api/v1/automation/GetAttachmentFromInvoice
        {invoiceNumber}                                      → the invoice's documents

C. Prepare (DocLink only, nothing written yet)
   build header + item values (sections 7–8), validate, fetch and check PDFs,
   show everything to the user → user confirms

D. Write to IREPS (same-origin AJAX from the IREPS tab)
Step 4   POST /epsn/ct/fetchPODetails.do       rly, poKey             → bill form (HTML)
Step 5   POST /epsn/ct/populatePayAuthList.do  payingRly, poKey       → paying authority
         POST /epsn/ct/populatePOSrList.do     ... stockNonstock      → PO Sr list
         POST /epsn/common/getAjaxData.do      gstNo                  → GSTIN validation
         POST /epsn/ct/saveBillHeader.do       (header fields)        → billRegNo   ⚠ creates draft bill
Step 7   POST /epsn/ct/fetchPOItemDetails.do   poSrNo, billRegNo ...  → item, consignee, PO tax rate, inspection agency
         POST /epsn/ct/populateROList.do       poSrNo                 → receipt (RO/CRN) list
         POST /epsn/ct/populateRODetails.do    roNo                   → receipt qty, R-Note, DRR, item value
         POST /epsn/ct/saveBillDetails.do      (item fields)          → dispatchNo + auto-attached R-Note/CRN

E. Documents and submission (user at the keyboard)
Step 9   per document:
           wss://127.0.0.1:2175  action=pdfsign   (user picks file + signs in IREPS signing app)
           POST /cgi-bin/save.php              multipart, signed PDF  → stored path
           POST /epsn/ct/uploadBillDocuments.do fileDesc, filePath    → document list
Step 10  POST /epsn/ct/generateBillPreview.do  billRegNo              → preview HTML (+ Struts TOKEN)
Step 11  POST /epsn/ct/supplierBillPDF.do      html                   → "OK:<base64 PDF>"
Step 12  wss://127.0.0.1:2175  action=pdfsign tbs=<base64 PDF>        → signed PDF   (DSC + PIN)
Step 13  POST /epsn/ct/generatePDF.do          TOKEN, signed pdfContent → submitted bill PDF

F. Close the loop (open item)
   mark the invoice "Sent to Doculink" in ECM so it is not billed twice
```

All `/epsn/ct/*` calls are same-origin jQuery AJAX posts
(`application/x-www-form-urlencoded; charset=UTF-8`,
`X-Requested-With: XMLHttpRequest`, `Referer: …/epsn/ct/fetchPODetails.do`).
Only `generatePDF.do` carries the Struts token. The session is the normal
IREPS cookie.

---

## 5. ECM side (J2W ↔ ECM)

From the sheet *Meta data from ECM Bill upload*. Neither call has been run
yet; the response format is not documented (the sheet itself asks
"Multiple? Single?").

### 5.1 Calls

**1st call: find the invoice for a receipt**
```
POST <DOMAIN>/nuxeo/site/api/v1/automation/RetrieveInvoiceData
Authorization: Bearer <TOKEN>
Content-Type: application/json+nxrequest
{"params":{"customerPO":"<CUSTOMER_PO_NUMBER>",
           "customerPOSrNo":"<CUSTOMER_PO_SERIAL_NUMBER>",
           "invoiceQuantity":"<INVOICE_QUANTITY>"}}
```
Spec rule (Bill Upload step 4): match on customer PO no + PO Sr no + qty +
"Sent to Doculink"; **if more than one record matches, fail.** The business
also notes that one PO Sr carries one invoice ("1 serial number – 1 invoice";
multi-line not applicable for IREPS).

**2nd call: fetch the documents**
```
POST <DOMAIN>/nuxeo/site/api/v1/automation/GetAttachmentFromInvoice
Authorization: Bearer <TOKEN>
Content-Type: application/json+nxrequest
{"params":{"invoiceNumber":"<INVOICE_NUMBER>"}}
```
The invoice number comes from the 1st call.

**Alternative for the documents:** DocLink already searches ECM with NXQL
(`services/ecm-direct.js`). The spec gives one query per document type
(section 6, step 9), scoped by `ecm:ancestorId`.

**Auth and hosts:** `services/ecm-direct.js` already gets a Bearer token
(`POST /nuxeo/oauth2/token`, client credentials) and retries once on 401.
The automation calls can reuse it. The spec's path is
`/nuxeo/site/api/v1/automation/…`, while `ecm-direct.js` uses
`/nuxeo/api/v1/…`. Nuxeo serves the REST API under both prefixes; check
which one this ECM accepts. `manifest.json` already grants the TST ECM host.

**Site ids** (`ecm:ancestorId`; also in `services/ecm-catalog.js`):

| Site | IREPS account | TST | PRD |
|---|---|---|---|
| Hosur | `833` | `ad5090e5-648d-4f75-8c14-7052e8ac3b72` | `7dfe3fc0-3157-489d-826a-9435e65631fc` |
| Rohtak | `60828` | `34a61f51-10fe-44ce-a669-2ea14dc86ff4` | `f2a5bf87-877b-4e4c-b4fc-7301cabfd236` |

### 5.2 ECM invoice fields for the bill

Columns ECM already has (sheet *Oracle data available in ECM*; examples from
its sample rows):

| ECM column | Example | Used for |
|---|---|---|
| `invoiceNumber` | `1331000660`, `1061000617` | Tax invoice no. (header), challan match (step 4), ECM document fetch |
| `salesInvoiceDate` | `2026-08-18 00:00:00.000` | Tax invoice date. Convert to `dd/mm/yyyy`. |
| `onivla` | `63749.91` | Invoice amount incl. GST (header) and item-wise claim (step 7) |
| `quantity`, `offeredQuantity`, `orderQuantity` | `15` | Match key (`invoiceQuantity`) and check against receipt qty |
| `rate` | `3601.69` | Check against IREPS PO rate |
| `totalTaxValue` | `9724.56` | Tax amount: check, and GST % = tax ÷ (onivla − tax) (`9724.56 / 54025.35` = 18 %) |
| `taxCode` | `IGST` | IGST vs CGST+SGST check |
| `serviceAccountingCode` | `73269099` | HSN code (step 7) |
| `customerPONumber` | `5100032619` | Match key (customer PO) |
| `division` | `WABHSR` (Hosur), `WABRTK` (Rohtak) | Site, and probably supplier GSTIN (section 8) |
| `gstinRecipient` | `29AAACB4881D1ZQ`, `URD` | **Customer's** GSTIN. Candidate for state of supply (section 8). |
| `supplyPlace`, `consigneeLocation`, `consigneeName`, `consigneeAddressLine4` | `CHENNAI`, `CHENNAI, TN, 600038, IN` | Place of supply text; state of supply via the state code in the address |
| `partDescription` | `PARKING BRAKE SYSTEM` | Bill description (header) |
| `lineNumber`, `lineRef` | `2.1`, `1` | Oracle order line. **Not** the customer PO Sr no. (Open Point 7); `lineRef` is unverified. |
| `Sent to Doculink` | (new, empty) | Match key: skip invoices already sent |

Columns requested from Oracle → ECM (not present yet):

| Spec field | New column | Note |
|---|---|---|
| Customer PO Sr no. | `customerPOSrNumber` | Blocks the ECM match. Open Point 7 suggests the invoice print's "Customer line number". |
| TPI authority | `tpiAuthority` | Not needed: IREPS returns the inspection agency (`TPI` / `CONSG`) in `fetchPOItemDetails.do`. |
| GST % | `gstPercent` | Not needed: IREPS gives the PO rate; ECM `totalTaxValue` cross-checks it. |
| Supplier GSTIN (bill-from) | `gstinSupplier` | Derivable from `division` meanwhile (to be confirmed) |
| Payment % | `paymentTerm` | Arrives as a description; DocLink must extract the percentage (Open Points). |
| Stock / Non-stock | — | Oracle will not add it (Open Points: "No"). Not needed: IREPS gives it. |
| Guarantee months | — | Open; not used by the bill form |

---

## 6. Step by step

### Step 1 — Check R-Note / CRN availability
**Call:** `POST /epsn/searchPO.do` with `searchCriteria=RNOTE` (stock capture #11).
For CRN-based bills use `searchCriteria=CRN` (`crn_BILLSTATUS_MA.txt` #293).

R-NOTE result columns (from the capture):
`Sr. No. | Dept / Rly. Unit | PO No. | PO Date | PO_SR | RNOTE No. | RNOTE Date | RNOTE Qty | RO No. | RO Date | DRR No. | Bill Claim | Bill Reg No. | Bill Reg/Sign Date | Invoice No. | Invoice Date | CO6 No. | CO6 Date | CO7 No. | CO7 Date | Claim Amount | Passed Amount | Payment / Return Date | Return Reason | Action(s)`

The payment columns (`Bill Reg No.` onward) are in the HTML even when the page
shows "Hide Payment Details" (`class="payDtlCls"`).

Example row: `ECOR | 02261018101611 | 01/07/2026 | 001 | 4826100504 | 14/10/2026 | 87 Set | 48302601243 | 14/10/2026 | RT260464`

The **Bill Claim** cell of a billable row contains:
```html
<a href="#" onclick="postRequest('/epsn/ct/fetchPODetails.do?rly=11&poKey=6749760')"
   title="Click Here to claim new Supplier Bill">
```
This gives `rly` and IREPS's internal `poKey` directly, so no separate PO
search is needed. Rows that cannot be billed show text instead, e.g.
`Rnote Not Published`, `Signed`, `Paid`, `CO6 Number Allotted` (Screens 1, 3).

Other links in the row: PO PDF
(`/ireps/etender/pdfdocs/MMIS/PO/<yyyy>/<rly>/<poNo>.pdf`) and R-Note PDF
(`/ireps/etender/pdfdocs/MMIS/RN/<yyyy>/<rly>/<rnoteNo>.pdf`).

**Comments**
- DocLink already runs this search (R-NOTE / CRN downloads). The parser needs
  the qty fix (section 3) and must also keep `rly` and `poKey` from the Bill
  Claim link.
- **Search both R-NOTE and CRN.** Stock bills go against an R-Note; the
  non-stock bill in the other capture went against a CRN, and its R/NOTES tab
  said "No Record Found".
- Quantity carries a unit (`87 Set`, `15 Nos.`). Strip it before comparing.
- PO Sr is always three digits, zero-padded (`001`, `043`).
- The search covers the last 180 days (`searchRange=1`), or a date range.

### Steps 2–3 — Download / collect documents
Not required (spec). The documents are fetched from ECM in step 9.

### Step 4 — Match with ECM and open the bill form
**ECM:** `RetrieveInvoiceData` with customer PO no + PO Sr no + qty (section
5.1). ECM has the PO no. and quantity, but not the PO Sr no. (Open Points 1,
2, 7).

**Possible alternative key: invoice number.** In every example found, the
IREPS *Challan No.* equals the tax invoice number:

| Where | Challan No. | Tax Invoice No. |
|---|---|---|
| CRN tab `showCrnList.do` (non-stock #252) | `1061000262` | `1061000262` |
| Screenshots, Screen 3 vs Screen 6 | `3320260101270` (21-02-2026) | `3320260101270` (21/02/2026) |
| CRN search #293, row 3 | `1331001276` | `1331001276` |

ECM already has `invoiceNumber`. The challan number appears in the CRN search
and the per-PO R/NOTES and CRN tabs (`showReceiptNotes.do`, `showCrnList.do`),
but **not** in the R-NOTE search grid. This rests on three examples where the
vendor typed the invoice number as the challan number; confirm with the
business before relying on it. It would also need an ECM lookup by invoice
number, which `RetrieveInvoiceData` does not offer as specified.

**IREPS call:** `POST /epsn/ct/fetchPODetails.do` with `rly`, `poKey` (#55).
Returns the bill-entry page (~200 KB HTML). Values to read from it:

| Value | Where in the page | Example |
|---|---|---|
| `organization`, `department`, `unit` | hidden inputs | `01`, `19`, `14651` |
| `vendorCode`, `companyName`, `poNumber`, `poDate` | hidden inputs | `:833`, `FAIVELEY … -HOSUR` |
| `nitOid`, `paymentCode` | literals inside the page script that builds the header request | `nitOid:'107092947'`, `paymentCode:'000000'` |
| PO payment terms | literals in `checkPaymentTerms()`: `advancePercent`, `finalPercent` | `'0'`, `'0'` in both captures |
| Bank account, IFSC | pre-filled text inputs | — |
| Supplier GSTIN options | `<select name="supplierGSTIN">` | `06AAGCS8525B1ZI`, `02AAGCS8525B1ZQ`, `33AAGCS8525B1ZL` |
| Paying railway options | `<select name="payingRly">` | one option |
| Railway GSTIN options | `<select name="rlyGSTIN">` | all states, `AAAGM0289C…` (non-IRFC) and `AAACI0681C…` (IRFC) series |
| Struts token, cert thumbprint | hidden inputs | needed only for `generatePDF.do` |

`nitOid` differs per PO, so it has to be parsed from the page script for every
bill. When the PO payment terms are non-zero, the page warns ("Please ensure to
submit Bill as per PO Payment Terms") if Payment % does not match them. That
makes them a possible IREPS source for Payment % (not yet seen with values).

### Step 5 — Bill header ("15 entries")
**Calls**

| # | Call | Request | Response (observed) |
|---|---|---|---|
| 109 | `populatePayAuthList.do` | `payingRly=11&poKey=6749760` | `success^^A1001-11^^PFA/ECoR/BBS(A1001)-3101-ECOR` |
| 111 | `populatePOSrList.do` | `rly, poNumber, payingAuthorityCode=A1001, billType=S, billRegNo=null, stockNonstock=S, payingRly` | `success^^001` |
| 112 | `common/getAjaxData.do` | `gstNo=06AAGCS8525B1ZI` | `1013:Haryana^false^Valid GSTIN^06AAGCS8525B1ZI^FAIVELEY …^…^Regular` |
| 113 | `saveBillHeader.do` | see below | `success^^3816672` (= billRegNo) |

`saveBillHeader.do` request (stock capture; test values marked †):
```
invoiceAmount=1000000†  invoiceType=I  payingRly=11  stockNonstock=S  fuelNonFuel=N
multiInvoiceFlag=N  invoiceCount=1  billType=S  spmBillRegNo=null
organization=01  department=19  unit=14651  rly=11  poKey=6749760
poNumber=02261018101611  poDate=01/07/2026  companyName=FAIVELEY … -HOSUR
pvc=N  svcFlag=Y  gstFlag=Y  gstRegFlag=Y  reverseChargeFlag=N  compositeFlag=N
supplierGSTIN=06AAGCS8525B1ZI  vendorCode=:833  payingAuthorityCode=A1001
invoiceNo=123456†  invoiceDate=14/10/2026  paymentType=F  paymentPercent=100
bankAccountNo=<prefilled>  ifscCode=<prefilled>
billDescription=All the bills†  placeOfSupply=Bangalore†  stateOfSupply=29†  supplierState=06
ipasAUCode=3101  nitOid=107092947  supplementaryBillType=  paymentCode=000000
additionalPayment=  totalAmount=  rcvIdStr=  rcvRefundClaimAmtStr=  rrlNoStr=  rrlDateStr=
rrlValueStr=  totalBalanceAmtWraDouble=0
```
Real values from the other bills:

| Field | Non-stock capture #369 (Rohtak invoice) | Screens 6–7 (Hosur invoice) |
|---|---|---|
| `invoiceNo` / date | `1061000262` / `08/08/2026` | `3320260101270` / `21/02/2026` |
| `invoiceAmount` | `485777` | `351994` |
| `supplierGSTIN` / `supplierState` | `06AAGCS8525B1ZI` / `06` | `33AAGCS8525B1ZL` / Tamil Nadu |
| `stateOfSupply` | `18` (Assam) | Uttar Pradesh (`09`) |
| `placeOfSupply` | `coaching Depot/Guwah` (20-char limit) | `SMM/ETD /KANPUR` |
| `billDescription` | `CLAIM FOR 100% PAYMENT` | `KIT FOR UNLOADER EXHAUST VALVE FTRTIPL PART NO. 790002165` |
| Paying authority | `A3001` | `WAO/JHS(A3502)-3207-NCR` |

**Comments**
- `ipasAUCode` is taken by the page from the paying authority label:
  `label.split('-')` second-last part → `3101`.
- `stockNonstock` must be right before `populatePOSrList.do` returns the PO Sr.
  It follows from the source in step 1 (R-NOTE → `S`, CRN → `N` in the captured
  cases) and is also a column in the PO search (`Stock/Non-Stock`, `S` / `NS`,
  Screen 2) and printed in the PO PDF title. The page refuses to save without
  a PO Sr: "No PO Sr found. Please select the correct option for
  Stock-NonStock and Bill Paying Authority".
- **This call creates a draft bill on IREPS.** IREPS itself warns "Bill header
  once saved is not editable" (Screen 6). DocLink must store the returned
  `billRegNo` and ask the user to confirm before calling it.
- Page-side checks to repeat in DocLink: invoice no. ≤ 16 chars, only
  `A–Z a–z 0–9 - /`; Payment % an integer ≤ 100; invoice amount ≤ 12 chars;
  place of supply ≤ 20 chars; bill description ≤ 200 chars; supplier GSTIN
  15 chars; IFSC and bank account `A–Z 0–9`.
- On failure the response is the error text itself (first `^^` field), which
  the page shows in an alert.
- Field sources: section 8.

### Step 6 — Select PO Sr
`populatePOSrList.do` (#111) → `success^^001`. Check that it equals the PO_SR
from step 1. The list depends on `stockNonstock` and the paying authority; the
page warns that a missing PO Sr means a different paying authority is needed
(Screen 7).

### Step 7 — Billing details ("5 entries")
**Calls**

| # | Call | Request | Response |
|---|---|---|---|
| 114 | `fetchPOItemDetails.do` | `poSrNo=001, rly, poKey, poNumber, billNo=<invoiceNo>, paymentType=F, billRegNo=3816672, gstFlag=Y, payingRly, billType=S, spmBillRegNo=null` | blocks separated by `@#$%`, fields by `^^` (below) |
| 115 | `populateROList.do` | `rly, poNumber, poSrNo, billType, billRegNo=null, payingRly` | `success^^1^^48302601243` (count, then RO/CRN numbers) |
| 116 | `populateRODetails.do` | `rly, poNumber, poSrNo, roNo=48302601243, billType, paymentPercent=100, payingRly` | `^^`-separated (below) |
| 117 | `saveBillDetails.do` | item fields (below) | `success^^3970712^^123964.56^^29AAAGM0289C1ZF^^OK#1<>48302601243.pdf#…/RN/2026/11/4826100504.pdf#RNOTE / CRN - SYSTEM UPLOAD#14/10/2026 16:32#<user>#<id><>` |

`fetchPOItemDetails.do` response, stock capture. Field meanings are inferred
from the values and from what the page sends to `saveBillDetails.do`.
```
success
@#$% 001 ^^ 29160388 (PL no) ^^ <description> ^^ 19/10/2026 (delivery date) ^^ 20712804 (allocation)
     ^^ 87 (qty ordered) ^^ 7916 (PO rate) ^^ Set (unit) ^^ 03 (unit code) ^^ 1
@#$% % ^^ -1 ^^ -1 ^^ U ^^ -1 ^^ % ^^ -1 ^^ -1        (charge units: discount, packing, ED, freight, …, sales tax, other1, other2)
@#$% 0 ^^ 0 ^^ 0 ^^ 0 ^^ 0 ^^ 18 ^^ 0 ^^ 0            (charge rates: sales-tax/GST rate on the PO = 18)
@#$% NA ^^ NA                                          (other charge descriptions)
@#$% 0 ^^ 004800 ^^ DLS/VSKP (Andra Pradesh, GST# 37AAAGM0289C1ZI) ^^ null ^^ null ^^ null   (consignee code, name, state, railway GSTIN)
@#$% TPI                                                (inspection agency; non-stock bill: CONSG)
@#$% NA
@#$% disabled
```

`populateRODetails.do` response (index: stock / non-stock):

| # | Stock (#116) | Non-stock (#372) | Meaning (inferred) |
|---|---|---|---|
| 1 | `14/10/2026` | `04/09/2026` | RO / CRN date |
| 2 | `87` | `15` | receipt quantity |
| 3 | `RT260464` | `Not Applicable` | DRR no. |
| 5 | `4826100504` | `Not Applicable` | R-Note no. |
| 6 | `14/10/2026` | `Not Applicable` | R-Note date |
| 8 | ` 4826100504:87` | `NA` | R-Note qty breakup (`rnoteNo:qty`, comma-separated) |
| 10 | `87.0` | `15.0` | billable quantity |
| 12 | `812656.56` | `485776.5` | item value |
| 13 | `0` | `0` | already passed |
| 14 | `812656.56` | `485776.5` | max claim |
| 15 | `…/MMIS/RN/2026/11/4826100504.pdf` | `…/MMIS/CONS/2026/05/643141/35294-26-66158_1.pdf` | receipt PDF URL |

**Inputs the user (or DocLink) types on this screen** (Screens 8–9; page
script `billFunctions.js`, stock #77):

| Screen label | Request field | Spec | Source |
|---|---|---|---|
| R-Note / RO No. (drop-down) | `roNo`, `roDate`, `roQty`, `drrNumber`, `rNoteNumber`, `rNoteDate` | 7a | IREPS #115/#116 |
| RO/CRN Qty Billed | `roQtyBilled` | — (not in spec) | receipt qty from #116; must be > 0 and ≤ RO qty |
| RLY GSTIN (drop-down) | `rlyGSTIN` | — | consignee's GSTIN from #114 |
| GST Category (drop-down) | `gstCategory` | 7b | `0` = "Regular GST (As per payment %)". Other values: `1` NIL Rated, `2` Non-GST Item, `3` Exempted, `4` Inclusive, `5` Full GST (100%), `7` Full GST with Full Freight |
| HSN Code | `hsnCode` | 7c | ECM `serviceAccountingCode`; digits only, ≤ 8 |
| IGST Rate or CGST Rate (drop-down) | `igstRate` or `cgstRate` (+`sgstRate`/`utgstRate` copied) | 7d | PO rate from #114 |
| ITC Admissible | `itcFlagFinal` | — | `N` |
| **Item-wise claim by vendor** | → `totalAmount` | **7e "Value"** | ECM `onivla`; must be > 0 and ≤ Max Claim |

**How the page computes the amounts** (`calculateExpAmt`, `saveDtls` in
`billFunctions.js`):
- taxable (`expenseAmount`, "Taxable Amount") = basic bill rate × RO/CRN qty
  billed × Payment % / 100, plus packing/freight/forwarding/other charges.
- tax (`basicAmount`, "Tax Amount") = taxable × GST rate. The field names do
  not match their meaning.
- IGST is enabled when the header `stateOfSupply` ≠ `supplierState`;
  otherwise CGST, and SGST (or UTGST for a union territory) is set to the
  same rate. Allowed values: IGST `0,1,2,3,5,8.9,12,13.8,18,28,40`; CGST
  `0,0.5,1,1.5,2.5,4.45,6,6.9,9,14,20`.
- `maxClaim` starts as the max claim from #116 (item value − already passed).
  **If the header invoice amount (rounded) is larger, the page raises
  `maxClaim` to the invoice amount**, and it does the same when PVC, freight
  or forwarding is non-zero.
- "Item-wise claim by vendor" overrides the calculated total:
  `totalAmount` = item-wise claim. Saving fails if it is 0 or above `maxClaim`.
- `amountClaimed` is the amount already claimed on this bill (`0` for the
  first item).

`saveBillDetails.do` request (stock capture, non-zero values; test values †):
```
billType=S gstFlag=Y rly=11 poKey=6749760 poNumber=02261018101611 poDate=01/07/2026
pvc=Not Applicable billRegNo=3816672 paymentType=F poSrNo=001 invoiceNo=123456† invoiceDate=14/10/2026
billItemSrNo=1 plNo=29160388 description=<item description> consigneeCode=004800 unitCode=03
deliveryDate=19/10/2026 allocation=20712804 qtyOrdered=87 poRate=7916 paymentPercent=100
disUnit=% stUnit=% stRate=18 frtUnit=U netBasicRate=7916
expenseAmount=688692.00 basicAmount=123964.56 totalAmount=123964.56† amountClaimed=0
gstCategory=0 itcFlagRail=N hsnCode=2345243† igstRate=18 igstAmount=123964.56
drrNumber=RT260464 itcFlagRoad=N itcFlagFinal=N roNo=48302601243 roDate=14/10/2026 roQty=87 roQtyBilled=87
compositeFlag=N inspectionAgency=TPI rlyGSTIN=29AAAGM0289C1ZF† maxClaim=1000000†
rNoteNumber=4826100504 rNoteDate=14/10/2026 fuelNonFuel=N rnUrl=<R-Note PDF URL>
(+ zero/blank: dispatchNo, pvcOnPoRate, rr*, ic*, pkg*, ed*, fwd*, frt*, oth*, cgst/sgst/utgst/cess, challan*, drrDate, …)
```
The non-stock capture (#373) differs mainly in `dispatchMode=NA`,
`drrNumber=Not Applicable`, `rNoteNumber=Not Applicable`,
`inspectionAgency=CONSG`, `rlyGSTIN=18AAAGM0289C1ZI` (= consignee's GSTIN),
`hsnCode=85452000`, `expenseAmount=411675.00`, `basicAmount=74101.50`,
`totalAmount=485776.50`, `maxClaim=485776.5`.

**Comments**
- † **The stock capture's amounts are test values, not a rule.** The tester
  typed an item-wise claim of `123964.56`, so `totalAmount` is that number.
  `maxClaim=1000000` is the test header invoice amount, raised by the rule
  above. In both real bills, item-wise claim = taxable + tax = item value =
  invoice amount: non-stock 411675.00 + 74101.50 = 485776.50; Screen 8
  298300.00 + 53694.00 = 351994.00 (100 × 2983 at 18 %).
- **DocLink should calculate the amounts and send ECM `onivla` as the
  item-wise claim:** taxable = qty × PO rate × Payment %/100; tax = taxable ×
  rate; total = taxable + tax. Stop if the total differs from `onivla` by more
  than rounding. IREPS accepted a header `invoiceAmount` of 485777 against
  a calculated 485776.50. IREPS will **not** stop an over-claim when the
  invoice amount is higher than the item value, because it raises `maxClaim`
  to the invoice amount, so DocLink must check this itself.
- `stRate` / GST rate comes from the PO (#114, block 3). The spec's "GST % —
  ECM" is therefore available from IREPS; ECM `totalTaxValue` / `taxCode` are
  cross-checks.
- The IGST/CGST choice follows the **header** state of supply, so a wrong
  `stateOfSupply` in step 5 cannot be fixed here (the header cannot be edited).
- `rlyGSTIN` should be the consignee's GSTIN from #114: `37AAAGM0289C1ZI`
  here, `18AAAGM0289C1ZI` in the non-stock bill, and `09AAAGM0289C1ZH` on
  Screen 8 (Uttar Pradesh). The stock capture picked `29AAAGM0289C1ZF`, which
  does not match. IREPS shows a note when a non-IRFC GSTIN is selected; both
  real bills used the non-IRFC one.
- When `populateROList.do` returns more than one receipt, pick the RO No. from
  the step-1 row.
- `saveBillDetails.do` returns `dispatchNo` (`3970712`), which the document
  upload needs, and the railway GSTIN IREPS stored.

### Step 8 — R-Note / CRN auto-attached
IREPS attaches the receipt PDF itself; it appears in the `saveBillDetails.do`
response as `RNOTE / CRN - SYSTEM UPLOAD`. Nothing to do.

### Step 9 — Upload supporting documents ("7 entries")
Not in the stock capture (it stops before uploading). From the non-stock
capture (#365 signer, #375–#384 uploads). Each document takes three actions:

**1. Sign in the IREPS signing app** (eMudhra "IREPSSigner", local websocket
`wss://127.0.0.1:2175`, pdfsigner v1.5; the page also connects to
`wss://127.0.0.1:2039`, v1.3). The page calls
`CRISPKI.Init('websigner,filer,pdfsigner')` and sends:
```
action=pdfsign tbs=Please Select your Digital Signature Certificate to Sign the above Selected PDF File
signaction=1 certtype=DS expirycheck=true issuername= signtype=detached
coordinate=90,90,10,10 thumbprint=<DSC thumbprint>
```
The signer opens its own window: the user clicks **Browse** to pick the PDF,
selects the certificate and signs. The reply is `signature=<base64 signed PDF>`.
The signer rejects files of 8 MB or more ("Please upload file below 8 MB in
size", Screen 12). In the capture, 5 documents took 6 signing prompts (one was
cancelled: `signing canceled completed`).

**2. Store the file:** `POST /cgi-bin/save.php`, multipart:

| Part | Value |
|---|---|
| `app_name` | `ireps` |
| `request_from` | (empty) |
| `relative_dir` | `ireps/upload/billDocuments/<MMYYYY>/<billRegNo>/<dispatchNo>` e.g. `…/092026/3744921/3894570` |
| `isBid` | `N` |
| `upfilename` | `upFile` |
| `savename`, `docSize` | (empty) |
| `pdfContent` | base64 of the **signed** PDF |
| `pdfName` | file name, e.g. `1061000262_TAXINVOICE_SIGNED.pdf` |
| `upFile` | the file |

Response: `<html><body onload='window.parent.CRISPKI.afterUpload()'>OK~ireps/upload/billDocuments/092026/3744921/3894570/1061000262_TAXINVOICE_SIGNED.pdf~37233</body></html>`
(path and size in bytes).

**3. Register it on the bill:** `POST /epsn/ct/uploadBillDocuments.do`
```
billRegNo=3744921 dispatchNo=3894570 vendorCode=:833
fileName=1061000262_TAXINVOICE_SIGNED.pdf
filePath=ireps/upload/billDocuments/092026/3744921/3894570/1061000262_TAXINVOICE_SIGNED.pdf
fileDesc=Invoice spmBillRegNo=null supplementaryBillType=
```
Response: `OK#<count><>` followed by every document on the bill as
`fileName#path#description#date time#uploaded by#id<>`.

**The document description (`fileDesc`) is free text.** Every document type
uses the same two calls; only `fileDesc` differs. Descriptions and file names
seen:

| Bill | `fileDesc` (file name) |
|---|---|
| Non-stock capture (CONSG) | `Invoice` (`1061000262_TAXINVOICE_SIGNED.pdf`), `guarantee warranty` (`1061000262 - GARRANTYWARRANTYCERTIFICATE.pdf`), `GST MANDATE` (`… - GSTMANDATE.pdf`), `MODVAT DECLARATION` (`… - MODVATDECLARATIONCERTIFICATE.pdf`), `WORK TEST CERTIFICATE` (`… - WORKCERTIFICATE.pdf`) |
| Screen 9 (CONSG) | `INVOICE` (`260101270 IN.pdf`), `GUARANTEE WARRANTY CERTIFICATE` (`… GC.pdf`), `DECLARATION` (`… DC.pdf`), `E INVOICING DECLARATION` (`E-DECLARATION..pdf`) |
| Screen 11 (TPI, CGST+SGST) | 7 files, among them `04253490104907…` (a 14-digit PO number, so probably the PO PDF), `… TI…`, `… WTC…`, `E-DECLARAT…` (descriptions hidden by the signer window) |

The non-stock file names follow the ECM document type names, so those files
were downloaded from ECM.

**Documents per the spec and their ECM source** (sheet *Meta data from ECM
Bill upload*; each NXQL query is
`SELECT * FROM Document WHERE InvoiceCertificateSchema:type = '<type>' AND ecm:ancestorId = '<site id>'`,
site ids in section 5.1):

| Spec document | ECM `InvoiceCertificateSchema:type` | When (spec) | Size (Downloads sheet) |
|---|---|---|---|
| a. Invoice | `generatedMerge` ("Generated Merge and not Tax invoice") | always | 200–400 KB |
| b. GC/WC | `garrantyWarrantyCertificate` | always | 90–150 KB |
| c. Modvat declaration | `modvatDeclarationCertificate` | always | ~100 KB |
| d. E-Declaration | `eDispatchNote` ("E-Dispatch Note") | optional; consignee inspection | ~3 MB |
| e. DP/MA | `modificationAdvise` | optional | 100–500 KB |
| f. WTC | `workCertificate` | always | 90–150 KB |
| g. IC | `inspectionCertificate` | third-party inspection | 60–65 KB |
| PO copy (not in the spec's step 9) | `poCopy` (query given in the sheet) | team uploads it (`Ireps_screen_upload.xlsx`, Screen 11) | 1–5 MB |
| Covering letter, GST mandate, LR copy | — ("no specific placeholder for upload in IREPS") | GST mandate was uploaded in the capture anyway | — |

All listed sizes are well under the 8 MB limit. The team reports a practical
limit of 7–8 attachments per bill.

The inspection agency from step 7 (#114) decides which conditional documents
apply: `TPI` → IC; `CONSG` → E-Declaration. The team's own description is
"consignee inspection – 6 documents (PO / MA / R-Note or CRN / WTC / GC/WC)"
and "third party inspection – 7 documents (… / IC)".

**Comments**
- **Points that conflict between sources (confirm with the business):**
  - *E-Declaration:* the spec says "consignee inspection only", yet the TPI
    bill on Screen 11 also carries an `E-DECLARAT…` file. On Screen 9 its
    description is `E INVOICING DECLARATION`, and the Downloads sheet calls it
    the turnover (> ₹10 crore) declaration. Its ECM type is `eDispatchNote`.
    Confirm that `eDispatchNote` is this document.
  - *Invoice:* the spec says use `generatedMerge`, not the tax invoice, but
    the captured bill uploaded `…_TAXINVOICE_SIGNED.pdf`.
  - *TPI authority comment* in the Meta data sheet: "TPI = Consignee.
    Inspection certificate will not be present & Edispatch note will also not
    be present". Read literally, this says a consignee-inspected bill has
    neither IC nor E-Dispatch note, which contradicts row d. Clarify.
- Signing stays manual, so DocLink can prepare but not complete this step
  without the user. Practical split: DocLink fetches the ECM documents by
  invoice number, checks each is a PDF under 8 MB, saves them to a known folder
  named `<invoiceNo>_<type>.pdf`, and shows the user which description to type
  for each. The user then clicks *Select File*, browses, signs, and enters the
  PIN; the IREPS page makes the `save.php` and `uploadBillDocuments.do` calls
  itself.
- Possible further step, **not verified**: for the final bill PDF the page
  sends the PDF bytes to the signer as `tbs` (step 12), with no Browse dialog.
  If the signer accepts that for supporting documents too, DocLink could send
  the ECM file to the signer (user still selects the certificate and enters the
  PIN) and then make the two upload calls. Test with the signer before
  designing around it.
- The `DocLink_API_Response_Doc.xlsx` Upload sheet marks E-Declaration, IC and
  DP/MA as "Not found". That only means they were not in the capture; they use
  the same API.

### Step 10 — Generate preview
`POST /epsn/ct/generateBillPreview.do` with `billRegNo, supplementaryBillType=null`
(non-stock #385). Returns the preview HTML (~22 KB), which also holds the
Struts token and DSC thumbprint used in step 13. It is read-only, so DocLink
can open it or the user can click *Generate Preview*. The preview lists all
bill values (R-Note details, inspection agency, invoice, GSTINs, HSN, rates,
taxable / tax / amount claimed, uploaded documents; Screen 10), which makes it
a good final check.

### Steps 11–13 — Sign & submit (manual)
1. `POST /epsn/ct/supplierBillPDF.do` with `html=<preview HTML, URL-encoded twice>`
   → `OK:<base64 PDF>` (PDF made by wkhtmltopdf).
2. Signer: `action=pdfsign tbs=<base64 PDF>`, sent in chunks (the signer
   replies `sendmore` between them) → `signature=<base64 signed PDF>`. The user
   selects the DSC and enters the 8-digit PIN (Screen 11).
3. `POST /epsn/ct/generatePDF.do`:
   ```
   org.apache.struts.taglib.html.TOKEN=<token from preview>  certThumbprint=<DSC thumbprint>
   signature=  billRegNo=3744921  spmBillRegNo=  invoiceDate=08/08/2026  vendorCode=:833
   companyName=FAIVELEY … -HOSUR  rly=05  poNumber=40265077101806  poKey=6710723
   spmLinkCo6No=  billType=S  supplementaryBillType=  pdfContent=<base64 signed PDF>
   ```
   → `application/pdf`, `Content-Disposition: attachment;filename=FAIVEL_833_3744921.pdf`.
   The submitted bill later appears at
   `/ireps/etender/ct/sbill/<MMYYYY>/FAIVEL_833_<billRegNo>.pdf` (seen in the
   CRN search).

---

## 7. Response formats at a glance

| Call | Success format |
|---|---|
| `populatePayAuthList.do` | `success^^<code>-<rly>^^<label>` |
| `populatePOSrList.do` | `success^^<poSr>[^^<poSr>…]` |
| `getAjaxData.do` (gstNo) | `<id>:<state>^<flag>^Valid GSTIN^<gstin>^<legal name>^…^<type>` |
| `saveBillHeader.do` | `success^^<billRegNo>` |
| `fetchPOItemDetails.do` | `success@#$%<block>@#$%…`, fields `^^` |
| `populateROList.do` | `success^^<count>^^<roNo>[^^…]` |
| `populateRODetails.do` | `success^^` + 15 fields (section 6, step 7) |
| `saveBillDetails.do` | `success^^<dispatchNo>^^<amount>^^<rlyGSTIN>^^OK#<n><><doc list>` |
| `save.php` | HTML with `OK~<path>~<bytes>` |
| `uploadBillDocuments.do` | `OK#<n><><doc list>` |
| `supplierBillPDF.do` | `OK:<base64 PDF>` |

Error responses were not captured. The page treats anything whose first `^^`
field is not `success` as an error and shows that text (one known message:
"Claim Amount is exceeding balance amount against RRL No…"). DocLink should
do the same: anything that does not start with `success` / `OK` is a failure,
shown raw.

---

## 8. Field sources and availability

### Bill header (step 5)

| # | Spec field | Request field | Source | Available? |
|---|---|---|---|---|
| 1–5 | Bill reg no., vendor name/code, account, address | `companyName`, `vendorCode` | IREPS form | Yes |
| 6–7 | GST / ED-ST | `gstFlag=Y` | constant | Yes |
| 8–9 | Tax invoice / debit note | `invoiceType=I` | constant | Yes |
| 10–11 | Stock / Non-Stock | `stockNonstock` | IREPS: R-NOTE vs CRN source, PO search column, PO PDF title | **Yes** (spec says ECM/TieQraft; Oracle will not add it; close the open point) |
| — | Fuel bill | `fuelNonFuel=N` | constant | Yes (not in spec) |
| 12–14 | Single invoice & single HSN | `multiInvoiceFlag=N`, `invoiceCount=1` | constant | Yes |
| 15–16 | Paying railway / authority | `payingRly`, `payingAuthorityCode`, `ipasAUCode` | IREPS (#109), one option | Yes |
| 17–18 | PVC / SVC | `pvc=N`, `svcFlag=Y` | page script | Yes |
| 19 | Tax invoice no. | `invoiceNo` | ECM `invoiceNumber` | Yes (≤ 16 chars; only `-` `/`) |
| 20 | Tax invoice date | `invoiceDate` (dd/mm/yyyy) | ECM `salesInvoiceDate` (`yyyy-mm-dd hh:mm:ss.sss`) | Yes |
| 21 | Invoice amount | `invoiceAmount` | ECM `onivla` (incl. GST) | Yes |
| 22 | Payment % | `paymentPercent` | default 100; ECM `paymentTerm` (not present); PO payment terms in the page script | Yes for normal bills; advance/retrofit open |
| 23 | Payment type | `paymentType` (`A` / `F`) | default `F` | Yes for normal bills; advance/retrofit open |
| 24–25 | Bank account / IFSC | `bankAccountNo`, `ifscCode` | pre-filled | Yes |
| 26–28 | Reverse charge / composition / GSTIN registered | `N`, `N`, `Y` | constant | Yes |
| 29 | Supplier GSTIN | `supplierGSTIN` | ECM `gstinSupplier` (not present) → meanwhile from ECM `division` | **Derivable, to confirm** (note 1) |
| — | Supplier state | `supplierState` | first 2 digits of supplier GSTIN | Yes once GSTIN known |
| — | State of supply | `stateOfSupply` (GST state code) | first 2 digits of ECM `gstinRecipient`, or the state in `consigneeAddressLine4` | **Derivable, to confirm** (note 2) |
| — | Place of supply | `placeOfSupply` (text, ≤ 20) | ECM `supplyPlace` / consignee name | Yes (not in spec) |
| — | Bill description | `billDescription` (≤ 200) | ECM `partDescription`, or a template such as `CLAIM FOR 100% PAYMENT` | Yes (not in spec) |
| — | `organization`, `department`, `unit`, `poKey`, `poNumber`, `poDate`, `nitOid`, `paymentCode` | | IREPS form / page script | Yes |

Notes:
1. **Supplier GSTIN follows the invoicing plant, not the IREPS account.** The
   Hosur account (`:833`) offers three GSTINs (`33…ZL` Tamil Nadu, `06…ZI`
   Haryana, `02…ZQ` Himachal). Evidence:
   - Screens 6–7: invoice `3320260101270` filed with `33AAGCS8525B1ZL`.
   - Non-stock capture: invoice `1061000262` filed with `06AAGCS8525B1ZI`.
     The `1061…` series belongs to `division = WABRTK` (Rohtak) in the ECM
     sample, and `1331…` to `WABHSR` (Hosur).

   Proposed rule until `gstinSupplier` exists: `WABHSR` → `33AAGCS8525B1ZL`,
   `WABRTK` → `06AAGCS8525B1ZI`. Check that the chosen GSTIN is one of the
   page's `supplierGSTIN` options and that `getAjaxData.do` says
   `Valid GSTIN`. Confirm with the business, including when `02…ZQ` is used.
2. **State of supply is needed before the consignee is known.** The consignee
   comes from `fetchPOItemDetails.do`, which needs the `billRegNo` that the
   header save returns. In both real bills the state of supply equals the
   railway GSTIN's state (Assam `18` / `18AAAGM0289C1ZI`; Uttar Pradesh / `09AAAGM0289C1ZH`).
   On a railway invoice ECM `gstinRecipient` should be that railway GSTIN,
   so its first two digits give the state code. The ECM sample has no
   railway invoices, so verify this on one. Fallbacks are the state code in
   `consigneeAddressLine4` (e.g. `CHENNAI, TN, 600038, IN`) or the PO /
   R-Note PDF. Getting this wrong sets the wrong tax type (IGST vs CGST+SGST)
   and the header cannot be edited.

### Billing details (step 7)

| Spec field | Request field | Source | Available? |
|---|---|---|---|
| a. R-Note no. | `roNo`, `rNoteNumber`, `rNoteDate`, `drrNumber`, `roQty`, `roQtyBilled` | IREPS #115, #116 | Yes |
| b. GST category | `gstCategory=0` (Regular GST, as per payment %) | constant | Yes |
| c. HSN code | `hsnCode` | ECM `serviceAccountingCode` | Yes (digits, ≤ 8) |
| d. GST % | `igstRate` or `cgstRate`+`sgstRate` | PO rate from #114; split by header states; cross-check ECM `taxCode`, `totalTaxValue` | **Yes** (spec says ECM; `gstPercent` not needed) |
| e. Value | item-wise claim → `totalAmount` | ECM `onivla`, checked against the calculated total | Yes |
| — | Taxable / tax amounts | `expenseAmount`, `basicAmount`, `igst/cgst/sgstAmount`, `maxClaim` | calculated (step 7) | Yes |
| — | Railway GSTIN | `rlyGSTIN` | consignee GSTIN in #114 | Yes |
| — | ITC admissible | `itcFlagFinal=N` | constant | Yes |
| — | Item data (PL no., description, consignee, delivery date, allocation, qty, rate, unit, inspection agency) | | IREPS #114 | Yes |
| — | Charges (discount, packing, freight, other) | | `0` / defaults in all bills seen | Yes |

---

## 9. Open items

**For ECM / Oracle**
1. Add **customer PO Sr no.** (`customerPOSrNumber`), or agree to match on
   invoice number via the IREPS challan number (step 4). Without one of them
   the ECM match cannot run.
2. Document the **response** of `RetrieveInvoiceData` and
   `GetAttachmentFromInvoice` (fields, single vs list, how files are returned)
   and the error for "no match" / "several matches".
3. Who sets **`Sent to Doculink`**, and when: after `saveBillHeader.do`, or after
   the user submits? DocLink must not bill the same invoice twice.
4. Add **supplier GSTIN** (`gstinSupplier`), or confirm the `division` rule
   (section 8, note 1).
5. Confirm that on railway invoices **`gstinRecipient`** is the railway
   GSTIN of the consignee state, so it can give the state of supply.
6. **Payment term** (`paymentTerm`) for advance/retrofit bills.

**For the business**
7. Confirm the challan number is always the tax invoice number.
8. Confirm the document descriptions (`fileDesc`) to use for each document type.
9. Invoice document: `generatedMerge` (spec) or the tax invoice (captured bill)?
10. E-Declaration: consignee inspection only (spec) or all bills (Screen 11)?
    Is ECM `eDispatchNote` the "E invoicing declaration"? Clarify the TPI
    comment in the Meta data sheet.
11. Should the PO copy, MA, GST mandate, covering letter and LR copy be
    uploaded (PO copy and GST mandate were uploaded in the bills seen)?
12. Rule for choosing a receipt when one PO Sr has several R-Notes / CRNs.
13. Close as open points: **Stock/Non-Stock**, **GST %** and **TPI authority**
    all come from IREPS.

**To capture next**
14. A bill with **several receipts** on one PO Sr, a **same-state** bill
    (CGST+SGST) as HTTP, an **advance** bill, and a **TPI** bill through
    document upload (IC).
15. An error response from `saveBillHeader.do` / `saveBillDetails.do` (e.g. a
    duplicate invoice number).
16. Whether the signer accepts `tbs=<PDF>` for supporting documents (step 9).
17. A PO whose page script has non-zero PO payment terms.

---

## 10. Implementation notes for DocLink

- **Run the write calls from the IREPS tab** (content script), so `Origin`,
  `Referer` and `X-Requested-With` match what the page sends. The read-only
  calls can stay where the existing download features run them.
- **Reuse the ECM client** in `services/ecm-direct.js` (token, retry on 401,
  site ids) for `RetrieveInvoiceData`, `GetAttachmentFromInvoice` or the NXQL
  document queries.
- **Stop on an ambiguous match:** no ECM invoice, more than one, or one
  already marked `Sent to Doculink`.
- **Confirm before `saveBillHeader.do`.** It creates a draft bill on IREPS and
  the header cannot be edited afterwards. Show the user the full header and
  item values first, with the source of each value.
- **Store progress per bill** (`billRegNo`, `dispatchNo`, uploaded documents)
  so a failure halfway can resume instead of creating a second draft.
- **Calculate amounts in DocLink** (step 7), send ECM `onivla` as the
  item-wise claim, and stop if it differs from the calculated total by more
  than rounding. IREPS does not catch an over-claim when the header invoice
  amount is high.
- **Validate before saving:**
  - invoice number ≤ 16 chars, only `-` `/`
  - PO Sr from #111 equals the step-1 PO_SR
  - receipt qty from #116 equals the step-1 qty and the ECM quantity
  - GST rate from #114 is in the allowed list and agrees with ECM `totalTaxValue`
  - IGST vs CGST from the states agrees with ECM `taxCode`
  - HSN ≤ 8 digits
  - place of supply ≤ 20 chars
  - each PDF < 8 MB
- **Hand over to the user** at step 9 (signing each document) and steps 11–13
  (preview, sign, submit).
- Fix the R-NOTE parser first (section 3) and keep the Bill Claim link's
  `rly` / `poKey`.

---

## 11. Implementation in DocLink

Started by hand from the side panel, **Upload Bill to IREPS**. Code in
`services/bill-upload/`, `background/bill-upload-job.js`,
`popup/popup-bill-upload.js`; tests in `test/bill-upload-tests.js`; mock in
`test/mock/mock-bill-upload.mjs` (TESTING.md C9).

| Study step | Implemented as |
|---|---|
| 1. R-Note / CRN | R-NOTE and CRN search by PO number (or last 180 days); only rows with a Bill Claim link are billable; rows IREPS already shows a bill for are not |
| 4. ECM match | `RetrieveInvoiceData` with customer PO, PO Sr, quantity; exactly one invoice not "Sent to Doculink", else stop. **Fallback:** the invoice typed by hand, since ECM has no PO Sr yet |
| 4-6. Bill page, header | Read-only calls first; header built per section 8 with every value's source; supplier GSTIN / state / place of supply / description editable and re-checked; `stockNonstock` tried on the other value when IREPS lists no PO Sr under the first |
| Pre-check | Before anything is written: receipt quantity and item value (`populateRODetails`) against the invoice |
| 5. Header save | Only after the user confirms, with no error and warnings read; the bill reg no. is recorded per receipt at once |
| 7. Item | Amounts computed as the bill page does; claim = computed total when it matches the invoice within 1 rupee; stops on charges / PVC / part bills; saved with the captured field order (the test reproduces the non-stock capture's `saveBillDetails.do` body byte for byte) |
| 9. Documents | Fetched from ECM with the sheet's per-type queries (narrowed to the invoice number, or the PO number for IC / MA / PO copy), newest per type, PDF and < 8 MB checked, saved locally with the description to type. Attaching, signing, preview and submit stay manual |

Choices made where the study left options:

- **Write calls run in the IREPS tab** (`chrome.scripting`, new `scripting`
  permission), as section 10 recommends.
- **Documents use the per-type NXQL queries**, not `GetAttachmentFromInvoice`,
  whose answer format is not documented; switch once it is.
- **Document descriptions** are DocLink defaults (`INVOICE`,
  `GUARANTEE WARRANTY CERTIFICATE`, `MODVAT DECLARATION`, `WORK TEST CERTIFICATE`,
  `E INVOICING DECLARATION`, `INSPECTION CERTIFICATE`, `MODIFICATION ADVICE`,
  `PURCHASE ORDER`) until the business confirms them (open item 8).
- **Bill description** defaults to ECM `partDescription`, else
  `CLAIM FOR 100% PAYMENT`.

Still to verify on the live portal: the `RetrieveInvoiceData` answer, and
opening a DocLink-created draft in IREPS to attach the documents (the R-NOTE
row offers "View / Sign & Submit Draft Supplier Bill"; whether documents can be
added there, or only from *Bills for Pay*, is not captured).

