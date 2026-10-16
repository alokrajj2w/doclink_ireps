# IREPS Supplier Bill Submission — API Study for DocLink Upload

What IREPS does when a vendor submits a supplier bill (spec: "Bill Upload"),
which HTTP calls carry each step, where each input value can come from, and
how much of it DocLink can fill automatically.

The **Upload Document** card in DocLink is still a Phase 2 placeholder. This
document is the basis for building it.

---

## 1. Sources

All capture files are local and live under `01_api_data/`, which is
git-ignored. The two HAR captures contain session cookies, so do not commit or
share them.

| Source | What it holds |
|---|---|
| `TSG India Doculink  ECM specifications.xlsx` → sheet **Bill Upload** | The 13-step manual flow and 29 first-screen fields, with columns for source (ECM / Defaulted / System / Manual) and comments |
| Same workbook → **Meta data from ECM Bill upload**, **Open Points** | ECM fields present or missing, ECM document-type queries, open questions |
| `BILL SUBMISSION-Screen shot of IREPS.docx` | 12 screenshots of the manual flow (Step 1 → Step 13, plus the file-size rule) |
| `DocLink Docs/Upload/3_GENERATEPDF.txt` (HAR, 21 MB) | **Complete non-stock bill**: PO search → bill header → item → 5 document uploads → preview → sign & submit. PO 40265077101806, CRN 35294-26-66158, bill reg 3744921 |
| `upload_flow_before_uploading_file.har` (HAR, 4 MB) | **Stock bill up to the item save**: R-NOTE search → bill header → item. PO 02261018101611, R-Note 4826100504, bill reg 3816672. Stops before document upload. |
| `DocLink Docs/Upload/1_savebillheader.txt`, `www.ireps.gov.in.har`, `generatepdf.txt` | Subsets of the above (header save; preview/sign for bill 3736795; a curl of `generatePDF.do`) |
| `DocLink Docs/Download/crn_BILLSTATUS_MA.txt` | A full CRN search result (entry #293, 2,023 rows) |

Entry numbers below (`#113` etc.) are HAR entry numbers as printed by
`har_inspect.py list`. They refer to the stock-bill capture unless marked
"(non-stock)".

The evidence covers **one stock bill and one non-stock bill, each a single PO
line with one receipt**. Multi-line POs, several receipts on one PO Sr,
advance/retrofit bills and multi-invoice bills have not been captured.

---

## 2. Summary

| Spec step | Can DocLink automate it? |
|---|---|
| 1. Check R-Note / CRN availability | **Yes**, using IREPS search calls DocLink already makes |
| 2–3. Download / collect documents | Not required (spec) |
| 4. Match with ECM, open the bill form | **IREPS side yes.** The ECM match is blocked until ECM stores the customer PO Sr no. |
| 5. Bill header | **Mostly.** Supplier GSTIN and state/place of supply are not yet available from any source. |
| 6. Select PO Sr | **Yes** |
| 7. Billing details | **Yes.** Only HSN comes from ECM; everything else comes from IREPS or is calculated. |
| 8. R-Note / CRN auto-attached | **Yes**, IREPS does it |
| 9. Upload supporting documents | **Partly.** Each file must be picked and signed in the IREPS signing app (manual). DocLink can fetch and prepare the files. |
| 10. Generate preview | Yes (read-only) |
| 11–13. Sign & submit | **Manual** (decision: signing stays manual) |

Three data gaps block a fully automatic header:

1. **Supplier GSTIN** of the invoicing entity (ECM column `gstinSupplier`, not present)
2. **State of supply / place of supply** (not in the spec, not in ECM)
3. **Customer PO Sr no.** for the ECM lookup (ECM column `customerPOSrNumber`, not present)

---

## 3. Action items found during the study

- **A real draft bill was created on live IREPS while capturing.** Bill reg
  **3816672**: PO 02261018101611, PO Sr 001, R-Note 4826100504, test values
  (invoice no. `123456`, amount `1000000`, HSN `2345243`, state of supply
  Karnataka). It claims the full 87 Set. It was not signed, so it is not
  submitted, but it should be deleted from *Bills for Pay* before the real bill
  for that R-Note is raised.
- **The DocLink R-NOTE parser maps the `RNOTE Qty` column to the R-Note number.**
  In `services/rnote/rnote-parser.js`, `matchRnoteHeader("RNOTE Qty")` returns
  `"rnoteNo"`: the label normalises to `rnoteqty`, the fallback regex finds
  "no" inside "rnote", and the quantity overwrites the real R-Note number. The
  value survives only in `rawColumns["RNOTE Qty"]`. `RO No.`, `RO Date`,
  `DRR No.` and `Bill Claim` are not mapped either. The parser was written
  before a real R-NOTE result had been captured; one now exists (stock capture
  #11).

---

## 4. End-to-end call sequence

```
Step 1   POST /epsn/searchPO.do               searchCriteria=RNOTE  (or CRN)
           └─ row link "Claim Supplier Bill" → fetchPODetails.do?rly=..&poKey=..
Step 4   POST /epsn/ct/fetchPODetails.do       rly, poKey             → bill form (HTML)
Step 5   POST /epsn/ct/populatePayAuthList.do  payingRly, poKey       → paying authority
         POST /epsn/ct/populatePOSrList.do     ... stockNonstock      → PO Sr list
         POST /epsn/common/getAjaxData.do      gstNo                  → GSTIN validation
         POST /epsn/ct/saveBillHeader.do       (header fields)        → billRegNo   ⚠ creates draft bill
Step 7   POST /epsn/ct/fetchPOItemDetails.do   poSrNo, billRegNo ...  → item, consignee, PO tax rate
         POST /epsn/ct/populateROList.do       poSrNo                 → receipt (RO/CRN) list
         POST /epsn/ct/populateRODetails.do    roNo                   → receipt qty, R-Note, DRR, item value
         POST /epsn/ct/saveBillDetails.do      (item fields)          → dispatchNo + auto-attached R-Note/CRN
Step 9   per document:
           wss://127.0.0.1:2175  action=pdfsign   (user picks file + signs in IREPS signing app)
           POST /cgi-bin/save.php              multipart, signed PDF  → stored path
           POST /epsn/ct/uploadBillDocuments.do fileDesc, filePath    → document list
Step 10  POST /epsn/ct/generateBillPreview.do  billRegNo              → preview HTML (+ Struts TOKEN)
Step 11  POST /epsn/ct/supplierBillPDF.do      html                   → "OK:<base64 PDF>"
Step 12  wss://127.0.0.1:2175  action=pdfsign tbs=<base64 PDF>        → signed PDF   (DSC + PIN)
Step 13  POST /epsn/ct/generatePDF.do          TOKEN, signed pdfContent → submitted bill PDF
```

All `/epsn/ct/*` calls are same-origin jQuery AJAX posts
(`application/x-www-form-urlencoded; charset=UTF-8`,
`X-Requested-With: XMLHttpRequest`, `Referer: …/epsn/ct/fetchPODetails.do`).
Only `generatePDF.do` carries the Struts token. The session is the normal
IREPS cookie.

---

## 5. Step by step

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
`Rnote Not Published`, `Signed`, `Paid`, `CO6 Number Allotted`.

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
Not required (spec).

### Step 4 — Match with ECM and open the bill form
**ECM:** the spec matches on Customer PO no + PO Sr no + Qty. ECM has the PO
no. and quantity, but not the PO Sr no. (Open Points 1, 2, 7).

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
business before relying on it.

**IREPS call:** `POST /epsn/ct/fetchPODetails.do` with `rly`, `poKey` (#55).
Returns the bill-entry page (~200 KB HTML). Values to read from it:

| Value | Where in the page | Example |
|---|---|---|
| `organization`, `department`, `unit` | hidden inputs | `01`, `19`, `14651` |
| `vendorCode`, `companyName`, `poNumber`, `poDate` | hidden inputs | `:833`, `FAIVELEY … -HOSUR` |
| `nitOid`, `paymentCode` | literals inside the page script that builds the header request | `nitOid:'107092947'`, `paymentCode:'000000'` |
| Bank account, IFSC | pre-filled text inputs | — |
| Supplier GSTIN options | `<select name="supplierGSTIN">` | `06AAGCS8525B1ZI`, `02AAGCS8525B1ZQ`, `33AAGCS8525B1ZL` |
| Paying railway options | `<select name="payingRly">` | one option |
| Railway GSTIN options | `<select name="rlyGSTIN">` | all states, `AAAGM0289C…` and `AAACI0681C…` series |
| Struts token, cert thumbprint | hidden inputs | needed only for `generatePDF.do` |

`nitOid` differs per PO, so it has to be parsed from the page script for every
bill.

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
The non-stock capture's real values: `placeOfSupply=coaching Depot/Guwah`,
`stateOfSupply=18` (Assam, the consignee's state),
`billDescription=CLAIM FOR 100% PAYMENT`.

**Comments**
- `ipasAUCode` is taken by the page from the paying authority label:
  `label.split('-')` second-last part → `3101`.
- `stockNonstock` must be right before `populatePOSrList.do` returns the PO Sr.
  It follows from the source in step 1 (R-NOTE → `S`, CRN → `N` in the captured
  cases) and is also a column in the PO search (`Stock/Non-Stock`, `S` / `NS`)
  and printed in the PO PDF title.
- **This call creates a draft bill on IREPS.** DocLink must store the returned
  `billRegNo` and ask the user to confirm before calling it.
- Field sources: section 7.

### Step 6 — Select PO Sr
`populatePOSrList.do` (#111) → `success^^001`. Check that it equals the PO_SR
from step 1. The list depends on `stockNonstock` and the paying authority; the
page warns that a missing PO Sr means a different paying authority is needed.

### Step 7 — Billing details
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

`saveBillDetails.do` request (stock capture, non-zero values; test values †):
```
billType=S gstFlag=Y rly=11 poKey=6749760 poNumber=02261018101611 poDate=01/07/2026
pvc=Not Applicable billRegNo=3816672 paymentType=F poSrNo=001 invoiceNo=123456† invoiceDate=14/10/2026
billItemSrNo=1 plNo=29160388 description=<item description> consigneeCode=004800 unitCode=03
deliveryDate=19/10/2026 allocation=20712804 qtyOrdered=87 poRate=7916 paymentPercent=100
disUnit=% stUnit=% stRate=18 frtUnit=U netBasicRate=7916
expenseAmount=688692.00 basicAmount=123964.56 totalAmount=123964.56‡ amountClaimed=0
gstCategory=0 itcFlagRail=N hsnCode=2345243† igstRate=18 igstAmount=123964.56
drrNumber=RT260464 itcFlagRoad=N itcFlagFinal=N roNo=48302601243 roDate=14/10/2026 roQty=87 roQtyBilled=87
compositeFlag=N inspectionAgency=TPI rlyGSTIN=29AAAGM0289C1ZF† maxClaim=1000000‡
rNoteNumber=4826100504 rNoteDate=14/10/2026 fuelNonFuel=N rnUrl=<R-Note PDF URL>
(+ zero/blank: dispatchNo, pvcOnPoRate, rr*, ic*, pkg*, ed*, fwd*, frt*, oth*, cgst/sgst/utgst/cess, challan*, drrDate, …)
```
The non-stock capture differs mainly in `dispatchMode=NA`,
`drrNumber=Not Applicable`, `rNoteNumber=Not Applicable`,
`inspectionAgency=CONSG`, `rlyGSTIN=18AAAGM0289C1ZI` (= consignee's GSTIN),
and `totalAmount=485776.50`, `maxClaim=485776.5`.

**Comments**
- ‡ **Do not copy the amounts from the stock capture.** It sent
  `totalAmount=123964.56` (the tax alone) and `maxClaim=1000000` (the test
  invoice amount). In the real non-stock bill, `totalAmount` = taxable + tax
  and `maxClaim` = item value. DocLink should calculate:
  taxable = qty × PO rate (87 × 7916 = 688692.00), tax = taxable × rate
  (123964.56), total = 812656.56, and check the total against the ECM invoice
  amount. IREPS accepted a header `invoiceAmount` of 485777 against a
  calculated 485776.50 (rounding).
- The form field names do not match their meaning: `expenseAmount` is the
  taxable amount and `basicAmount` is the tax amount (in both captures).
- `stRate` / GST rate comes from the PO (#114, block 3). The spec's "GST % —
  ECM" is therefore available from IREPS; ECM `gstPercent` would be a
  cross-check only.
- IGST vs CGST+SGST: IGST when supplier state ≠ consignee state (both captures
  are inter-state). Same-state bills need `cgstRate` + `sgstRate` instead.
  Allowed values: IGST `0,1,2,3,5,12,13.8,18,28,40`; CGST
  `0,0.5,1,1.5,2.5,6,6.9,9,14,20`.
- `rlyGSTIN` should be the consignee's GSTIN from #114
  (`37AAAGM0289C1ZI` here). The stock capture picked `29AAAGM0289C1ZF`, which
  does not match.
- When `populateROList.do` returns more than one receipt, pick the RO No. from
  the step-1 row.
- `saveBillDetails.do` returns `dispatchNo` (`3970712`), which the document
  upload needs.

### Step 8 — R-Note / CRN auto-attached
IREPS attaches the receipt PDF itself; it appears in the `saveBillDetails.do`
response as `RNOTE / CRN - SYSTEM UPLOAD`. Nothing to do.

### Step 9 — Upload supporting documents
Not in the stock capture (it stops before uploading). From the non-stock
capture (#375–#384). Each document takes three actions:

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
cancelled).

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
uses the same two calls; only `fileDesc` differs. Descriptions seen:

| Capture / screenshot | `fileDesc` |
|---|---|
| Non-stock capture | `Invoice`, `guarantee warranty`, `GST MANDATE`, `MODVAT DECLARATION`, `WORK TEST CERTIFICATE` |
| Screen 9 | `INVOICE`, `GUARANTEE WARRANTY CERTIFICATE`, `DECLARATION`, `E INVOICING DECLARATION` |

**Documents per the spec and their ECM source** (sheet *Meta data from ECM
Bill upload*; queries are filtered by the Hosur or Rohtak `ecm:ancestorId`
listed there):

| Spec document | ECM `InvoiceCertificateSchema:type` | When |
|---|---|---|
| a. Invoice | `generatedMerge` (not the plain tax invoice) | always |
| b. GC/WC | `garrantyWarrantyCertificate` | always |
| c. Modvat declaration | `modvatDeclarationCertificate` | always |
| d. E-Declaration | `eDispatchNote` | optional; consignee inspection |
| e. DP/MA | `modificationAdvise` | optional |
| f. WTC | `workCertificate` | always |
| g. IC | `inspectionCertificate` | third-party inspection |
| (no IREPS slot in spec) Covering letter, GST mandate, LR copy | — | GST mandate was uploaded in the capture anyway |

The inspection agency from step 7 (#114) decides which conditional documents
apply: `TPI` → IC; `CONSG` → E-Declaration.

**Comments**
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
`POST /epsn/ct/generateBillPreview.do` with `billRegNo, supplementaryBillType=null`.
Returns the preview HTML (~22 KB), which also holds the Struts token and DSC
thumbprint used in step 13. It is read-only, so DocLink can open it or the
user can click *Generate Preview*. The preview lists all bill values (e.g.
`CRN Qty Billed: 15 out of 15`, uploaded documents), which makes it a good
final check.

### Steps 11–13 — Sign & submit (manual)
1. `POST /epsn/ct/supplierBillPDF.do` with `html=<preview HTML, URL-encoded twice>`
   → `OK:<base64 PDF>` (PDF made by wkhtmltopdf).
2. Signer: `action=pdfsign tbs=<base64 PDF>`, sent in chunks (the signer
   replies `sendmore` between them) → `signature=<base64 signed PDF>`. The user
   selects the DSC and enters the 8-digit PIN.
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

## 6. Response formats at a glance

| Call | Success format |
|---|---|
| `populatePayAuthList.do` | `success^^<code>-<rly>^^<label>` |
| `populatePOSrList.do` | `success^^<poSr>[^^<poSr>…]` |
| `getAjaxData.do` (gstNo) | `<id>:<state>^<flag>^Valid GSTIN^<gstin>^<legal name>^…^<type>` |
| `saveBillHeader.do` | `success^^<billRegNo>` |
| `fetchPOItemDetails.do` | `success@#$%<block>@#$%…`, fields `^^` |
| `populateROList.do` | `success^^<count>^^<roNo>[^^…]` |
| `populateRODetails.do` | `success^^` + 15 fields (section 5, step 7) |
| `saveBillDetails.do` | `success^^<dispatchNo>^^<amount>^^<rlyGSTIN>^^OK#<n><><doc list>` |
| `save.php` | HTML with `OK~<path>~<bytes>` |
| `uploadBillDocuments.do` | `OK#<n><><doc list>` |
| `supplierBillPDF.do` | `OK:<base64 PDF>` |

Error responses were not captured. DocLink should treat anything that does
not start with `success` / `OK` as a failure and show the raw text.

---

## 7. Field sources and availability

### Bill header (step 5)

| # | Spec field | Request field | Source | Available? |
|---|---|---|---|---|
| 1–5 | Bill reg no., vendor name/code, account, address | `companyName`, `vendorCode` | IREPS form | Yes |
| 6–7 | GST / ED-ST | `gstFlag=Y` | constant | Yes |
| 8–9 | Tax invoice / debit note | `invoiceType=I` | constant | Yes |
| 10–11 | Stock / Non-Stock | `stockNonstock` | IREPS: R-NOTE vs CRN source, PO search column, PO PDF title | **Yes** (spec says ECM/TieQraft, open — can be closed) |
| — | Fuel bill | `fuelNonFuel=N` | constant | Yes (not in spec) |
| 12–14 | Single invoice & single HSN | `multiInvoiceFlag=N`, `invoiceCount=1` | constant | Yes |
| 15–16 | Paying railway / authority | `payingRly`, `payingAuthorityCode`, `ipasAUCode` | IREPS (#109), one option | Yes |
| 17–18 | PVC / SVC | `pvc=N`, `svcFlag=Y` | page script | Yes |
| 19 | Tax invoice no. | `invoiceNo` | ECM `invoiceNumber` | Yes (max 16 chars; only `-` `/` allowed) |
| 20 | Tax invoice date | `invoiceDate` (dd/mm/yyyy) | ECM `salesInvoiceDate` | Yes |
| 21 | Invoice amount | `invoiceAmount` | ECM `onivla` (incl. GST) | Yes |
| 22 | Payment % | `paymentPercent` | default 100; ECM `paymentTerm` (not present) | Yes for normal bills; advance/retrofit open |
| 23 | Payment type | `paymentType` (`A` / `F`) | default `F` | Yes for normal bills; advance/retrofit open |
| 24–25 | Bank account / IFSC | `bankAccountNo`, `ifscCode` | pre-filled | Yes |
| 26–28 | Reverse charge / composition / GSTIN registered | `N`, `N`, `Y` | constant | Yes |
| 29 | Supplier GSTIN | `supplierGSTIN` | must come from the invoice's bill-from entity | **No** — ECM `gstinSupplier` not present |
| — | Supplier state | `supplierState` | first 2 digits of supplier GSTIN | Yes once GSTIN known |
| — | State of supply | `stateOfSupply` | consignee state / invoice place of supply | **No** (not in spec or ECM) |
| — | Place of supply | `placeOfSupply` (text, max 20) | invoice place of supply | **No** (not in spec or ECM) |
| — | Bill description | `billDescription` | template, e.g. `CLAIM FOR 100% PAYMENT` | Yes (not in spec) |
| — | `organization`, `department`, `unit`, `poKey`, `poNumber`, `poDate`, `nitOid`, `paymentCode` | | IREPS form / page script | Yes |

Notes:
- **Supplier GSTIN cannot be derived from the IREPS account.** The account is
  named "…-HOSUR" (vendor code `:833`), yet the non-stock bill was filed with
  `06AAGCS8525B1ZI` (Haryana/Rohtak), and the stock capture also used `06…`.
  The spec's "Hosur = 33, Rohtak = 06" rule must be applied to the invoicing
  plant, not to the IREPS account.
- **State of supply is needed before the consignee is known.** The consignee
  comes from `fetchPOItemDetails.do`, which needs the `billRegNo` that the
  header save returns. So state/place of supply must come from the invoice
  (GST invoices print Place of Supply) or from the PO / R-Note PDF.

### Billing details (step 7)

| Spec field | Request field | Source | Available? |
|---|---|---|---|
| a. R-Note no. | `roNo`, `rNoteNumber`, `rNoteDate`, `drrNumber`, `roQty` | IREPS #115, #116 | Yes |
| b. GST category | `gstCategory=0` (Regular GST, as per payment %) | constant | Yes |
| c. HSN code | `hsnCode` | ECM (HSN/SAC) | Yes |
| d. GST % | `igstRate` or `cgstRate`+`sgstRate` | PO rate from #114; split by states | **Yes** (spec says ECM; ECM `gstPercent` not present) |
| e. Value | `expenseAmount`, `basicAmount`, `totalAmount`, `maxClaim` | calculated from qty × PO rate | Yes. There is no free-text "Value" field; the ECM invoice value is a cross-check. |
| — | Railway GSTIN | `rlyGSTIN` | consignee GSTIN in #114 | Yes |
| — | ITC admissible | `itcFlagFinal=N` | constant | Yes |
| — | Item data (PL no., description, consignee, delivery date, allocation, qty, rate, unit, inspection agency) | | IREPS #114 | Yes |
| — | Charges (discount, packing, freight, other) | | `0` / defaults in both captures | Yes |

---

## 8. Open items

**For ECM / Oracle**
1. Add **supplier GSTIN** of the invoicing entity (`gstinSupplier`).
2. Add **place of supply / state of supply** from the invoice (new; not in the
   spec).
3. Add **customer PO Sr no.** (`customerPOSrNumber`), or agree to match on
   invoice number via the IREPS challan number (section 5, step 4).
4. **Payment term** (`paymentTerm`) for advance/retrofit bills.

**For the business**
5. Confirm the challan number is always the tax invoice number.
6. Confirm the document descriptions (`fileDesc`) to use for each document type.
7. Confirm whether GST mandate, covering letter and LR copy should be uploaded
   (GST mandate was uploaded in the captured bill).
8. Rule for choosing a receipt when one PO Sr has several R-Notes / CRNs.
9. Stock/Non-Stock can be closed as an open point: IREPS provides it.

**To capture next**
10. A bill with **several receipts** on one PO Sr, a **same-state** bill
    (CGST+SGST), an **advance** bill, and a **TPI** bill through document
    upload (IC).
11. An error response from `saveBillHeader.do` / `saveBillDetails.do` (e.g. a
    duplicate invoice number).
12. Whether the signer accepts `tbs=<PDF>` for supporting documents (step 9).

---

## 9. Implementation notes for DocLink

- **Run the write calls from the IREPS tab** (content script), so `Origin`,
  `Referer` and `X-Requested-With` match what the page sends. The read-only
  calls can stay where the existing download features run them.
- **Confirm before `saveBillHeader.do`.** It creates a draft bill on IREPS.
  Show the user the full header and item values first.
- **Store progress per bill** (`billRegNo`, `dispatchNo`, uploaded documents)
  so a failure halfway can resume instead of creating a second draft.
- **Calculate amounts in DocLink**, then compare with ECM `onivla`. Stop if they
  differ by more than rounding.
- **Validate before saving:** invoice number (≤ 16 chars, only `-` `/`), PO Sr
  from #111 equals step-1 PO_SR, receipt qty from #116 equals step-1 qty, GST
  rate is in the allowed list, each PDF < 8 MB.
- **Hand over to the user** at step 9 (signing each document) and steps 11–13
  (preview, sign, submit).
- Fix the R-NOTE parser first (section 3) and keep the Bill Claim link's
  `rly` / `poKey`.
