# DocLink — IREPS Document Automation (Chrome Extension, Manifest V3)

DocLink is a Chrome extension for users of the Indian Railways IREPS portal.
Version 1.5.0 implements the downloads below. One **Save to: Local |
ECM / S3** switch at the top of the panel applies to every download. Local saves
under `Downloads/DocLink/`. ECM / S3 sends Bill Status, CRN and R-NOTE to the
Recon Engine, which stores them in S3 and loads them into reconciliation, and
files IC, PO, MA and tender documents in the ECM folder of the signed-in IREPS
account's unit (Hosur 833, Rohtak 60828) - see sections 15 and 16.

* **Download IREPS Bill Status** (since 1.0.0): retrieves the Bill Status page
  from the user's already-authenticated IREPS browser session, extracts the
  bill records, builds an Excel workbook (one row per bill, plus an "Info"
  sheet) and saves it to `Downloads/DocLink/IREPS/`. The preview page still
  offers a text-based PDF of the same records.
* **Download IREPS CRN** and **Download IREPS R-NOTE** (new in 1.1.0): run
  the IREPS *PO Search* (`/epsn/searchPO.do`) for Consignment Receipt Notes
  (`searchCriteria=CRN`) or Receipt Notes (`searchCriteria=RNOTE`) and
  download the complete result table as an Excel workbook (or CSV) into
  `Downloads/DocLink/IREPS/CRN/` or `Downloads/DocLink/IREPS/RNOTE/` -
  DocLink's equivalent of the portal's "Export to Excel" button, but with
  every row, not only the visible page. Both share one PO Search layer;
  only the search criteria, the result parser, the export columns and the
  file name differ. See section 13.
* **Download IREPS MA Copies** (new in 1.1.0): runs the same PO Search for
  Modification Advices (`searchCriteria=MA`), lists the MAs of a chosen MA
  date (default: today), and downloads their actual MA PDF copies from the
  "View/Download MA" links into `Downloads/DocLink/IREPS/MA/<date>/`. See
  section 14.
* **Download Tender Documents** (`tender/`): reads the active IREPS account
  from the home page, scans **My Messages** for NIT / corrigendum messages in
  a From-To date range, and downloads each tender's NIT, attachments,
  corrigenda and My Offer (**NIT Documents**) into
  `Downloads/DocLink/<unit>/Tender_<no>/`. A corrigendum is its IREPS page,
  printed as Ctrl+P would (`Corrigendum_NN_<tender>.pdf`); a document attached
  to it is saved next to it under its IREPS name (`Corrigendum_NN_<tender>_Attachment_<n>.<ext>`
  when IREPS gives none). Negotiation / counter offer / LOA
  letters have their own buttons (by Letter Date), and correspondence comes
  from the Correspondence view. An LOA is the published letter page alone,
  printed as Ctrl+P would: one `LOA_<tender>.pdf` per tender, and nothing the
  letter links or embeds is downloaded. A counter offer is likewise its
  published letter page, printed (`Counter_Offer_<tender>_<letter id>.pdf`); a
  document attached to the counter offer is never downloaded in its place. A per-account
  ledger (`chrome.storage.local`) skips documents already downloaded, so
  "Retry failed" is safe. Financial and Commercial Tabulations are downloaded
  by the tenders' Closing Date from IREPS Closed Tenders (section 19); the
  Techno-Commercial Tabulation is never requested (blocked at the request
  layer). The feature
  runs in the side panel only; it has its own node tests (section 10).

* **Upload Bill to IREPS** (bill upload, started by hand): bills an ECM invoice
  against an IREPS R-Note / CRN up to the digital signature - finds the
  billable receipt, gets the invoice from the ECM (or as typed), reads and
  checks everything, then (after the user confirms) saves the bill header and
  item in IREPS and fetches the invoice's documents from the ECM. Attaching the
  signed documents and Sign & Submit stay with the user in IREPS. See section 20
  and `upload.md`.

**File names.** A PDF (or other file) that IREPS serves keeps the name IREPS gives
it, in Downloads and in the ECM: the response's `Content-Disposition` file name,
else the name in the URL that answered (`viewNitPdf_5470263.pdf`, `8794517.pdf`).
Only characters no file system accepts become `_`. DocLink names a file itself only
when it made the PDF (a page printed by Chrome, or the text rendering) or when IREPS
served it without a name (a POST to a `.do` action, e.g. a tabulation answered
directly). Those are the `NIT_<tender>.pdf`, `Corrigendum_NN_<tender>.pdf`,
`LOA_<tender>.pdf`, `Financial_Tabulation_<tender>.pdf`, `IC_<PO>_<SR>_<CALLID>.pdf`
... names below. When two different documents of one run would share a name in one
folder or one grouped ECM document, the later one gets `_2`, `_3`, ... in both places
(`utils/filename.js` `sourceFileName`, `tender-workflows.js` `reserveFileName`).

DocLink never asks for, reads, stores or forwards IREPS credentials, security
keys or session cookies. It acts as an authenticated browser client, not as a
credential manager.

---

## 1. What DocLink does

```
User logs into IREPS normally (security key)      <- unchanged, manual
        ↓
Chrome holds the authenticated IREPS session
        ↓
User opens DocLink → Download Bill Status
        ↓
DocLink POSTs viewBills.do (empty body) with credentials: "include"
        ↓
Chrome attaches the IREPS cookies itself
        ↓
DocLink validates the response (login page? session expired? Bill Status form?)
        ↓
DocLink reads the fresh Struts TOKEN from the returned form, if any (memory only)
        ↓
DocLink POSTs viewBills.do again: [TOKEN] + zone=-1 + searchRange=1 + submit=Show Results
        ↓
Every <table id="table_id"> block is parsed by its header labels
        ↓
Excel workbook built (sheet "Bill Status": one row per bill; sheet "Info")
        ↓
Saved to Downloads/DocLink/IREPS/IREPS_Bill_Status_YYYY-MM-DD_HH-mm-ss.xlsx
```

Values are reproduced exactly as IREPS returned them. Nothing is calculated,
corrected, reconciled or inferred.

---

## 2. Architecture

| Layer | File | Responsibility |
|---|---|---|
| UI | `popup/popup.html`, `popup.css`, `popup.js` | Rendered in Chrome's side panel (docked right, full height; the toolbar icon toggles it). Each tab has its own DocLink panel: Chrome hides it when you switch to another tab and restores it, as it was, when you return; tabs where you never opened it show nothing. DocLink's tools appear only while the panel's tab is on the portal `config.json` targets (mock on `localhost:8765`, or `www.ireps.gov.in`). Opened on any other page, it shows a "Go to IREPS and log in" page (its Open IREPS button loads IREPS in that same tab), the other portal gets a "switch target" hint, and a config URL missing from `host_permissions` is reported as a configuration error. No IREPS request is made from a non-IREPS tab. Rule: `utils/url-scope.js`, view: `popup/popup-gate.js`. Download cards (Bill Status, CRN), connection indicator, progress, results, login-required view, the *Upload* card (Upload Bill to IREPS, section 20) |
| Logging | `utils/logger.js` | Redacted, time-stamped log of every step, request, download and error from the service worker, panel and parser; last 1000 entries stored and mirrored into the side panel's console (Inspect). `doclinkLog.dump() / download() / clear()` in that console. See TESTING.md, "The DocLink log" |
| UI (PO Search) | `popup/popup-documents.js` | CRN and R-NOTE cards on the main screen, each like the Bill Status card: Search options (Last 180 Days / Select Date / PO No., Railway, file format), Download, progress and errors in the card, result in the bottom panel |
| Orchestration | `background/service-worker.js` | Runs the workflow, tracks job state, relays progress to the popup |
| DOM parsing | `background/offscreen.html`, `offscreen.js` | Offscreen document that owns `DOMParser` (service workers have none) |
| Networking | `services/ireps-api.js` | All IREPS URLs, the two `viewBills.do` requests, form-field constants, date-range validation, error codes |
| Form | `services/ireps-form.js` | Extracts the dynamic Struts TOKEN, zone list and searchRange controls from the page (DOM or regex, so it also runs in the service worker) |
| Flow | `services/bill-status-service.js` | `fetchBillStatus(options)`: page → session check → token → Show Results → parse → validate |
| Session | `services/session-service.js` | Content-based login / session-expired / Bill Status page detection |
| Parsing | `services/bill-parser.js` | Label-driven extraction of every `table#table_id` block (plus legacy table fallback) → structured bills + printable HTML |
| Recon | `services/recon-service.js` | "Save to: Recon (S3)": POSTs the export file to the Recon Engine's `/api/documents` with the user's Recon sign-in cookie; maps its answers to `RECON_*` errors (section 15) |
| Bill Status export | `services/bill-status-export.js` | Bill Status columns (`BILL_FIELDS` order) handed to the shared table exporter → .xlsx |
| PDF | `services/pdf-service.js` | Dependency-free PDF writer (Helvetica, wrapping, page breaks, headers/footers); used by the preview's "Download PDF" |
| Download | `services/download-service.js` | `chrome.downloads` with `uniquify` conflict handling |
| Bill upload | `services/bill-upload/`, `background/bill-upload-job.js`, `popup/popup-bill-upload.js` | ECM invoice -> IREPS supplier bill (section 20) |
| PO Search API | `services/search-po/search-po-api.js` | `/epsn/searchPO.do` requests (showPage, `searchCriteria=<type>` search, page links), document types, error codes, URL resolution |
| PO Search form | `services/search-po/search-po-form.js` | Extracts the Struts TOKEN, railway list, searchCriteria options and searchRange controls from the PO Search page |
| PO Search table | `services/search-po/search-po-table.js` | Generic result-table mechanics: table location by header, cell text, anchors, pagination links, page message |
| PO Search flow | `services/search-po/search-po-service.js` | `searchIrepsDocuments({ criteria })`: page → session → token → search → parse (routed by criteria) → follow result pages |
| PO Search export | `services/search-po/search-po-export.js` | Writes the download file from a header/rows table: Excel (.xlsx) or CSV; no PDF assumed |
| CRN | `services/crn/crn-parser.js`, `crn-export.js`, `crn-service.js` | CRN column map, link classification (CRN / claim / bill PDF), CRN export columns, `searchCrn()` |
| R-NOTE | `services/rnote/rnote-parser.js`, `rnote-export.js`, `rnote-service.js` | Layout-agnostic R-NOTE parser (rawColumns + links + document link detection), R-NOTE export, `searchRnote()` |
| MA | `services/ma/ma-parser.js`, `ma-service.js` | MA table parser (PO link vs `View/Download MA` link), MA-date filter, `searchMa()`, `downloadMaPdfs()` |
| Documents | `services/search-po/document-downloader.js` | Fetches a linked IREPS document with the browser session, verifies it is a PDF (login page → session expired), saves it; batches with limited concurrency |
| UI (MA) | `popup/popup-ma.js` | MA view: date / range / all, railway, PO filter, MA list with selection, Download Selected / All, per-MA status |
| Writers | `utils/xlsx-writer.js`, `utils/zip-writer.js` | Dependency-free Office Open XML workbook + ZIP (store) writers |
| Preview | `pages/preview.html`, `preview.js`, `preview.css` | Printable preview built from structured data; fallback "Print / Save as PDF" and in-page "Download PDF" |
| Utilities | `utils/logger.js`, `sanitizer.js`, `filename.js`, `messages.js` | Redacting logger, HTML sanitisation, file naming, message/stage/error catalogue |
| Tender documents | `tender/tender-*.js`, `tender.css` | Side-panel feature: account detection, My Messages scan, NIT / corrigendum / letter / correspondence downloads, ledger; loaded by `popup.html` (`tender-ui.js`) |

Message flow:

```
popup ──CHECK_IREPS_SESSION / DOWNLOAD_IREPS_BILL_STATUS / GET_JOB_STATE──▶ service worker
popup ◀──IREPS_PROGRESS / IREPS_DOWNLOAD_COMPLETE / IREPS_DOWNLOAD_ERROR────── service worker
service worker ──PARSE_BILL_STATUS (html)──▶ offscreen document ──▶ parsed result
```

The job runs in the service worker, so closing the popup does not cancel it.
Reopening the popup restores the current or last state via `GET_JOB_STATE`.

---

## 3. Folder structure

```
doclink/
├── manifest.json  config.json  (config.local.json: gitignored overrides, never packaged)
│                  config.local.prod.example.json  (PROD ECM template for config.local.json; never read)
├── background/
│   ├── service-worker.js      job orchestration, message router (handlers keyed by MESSAGE_TYPES)
│   ├── offscreen.html / offscreen.js   DOMParser for the worker (one answer() per parse request)
│   ├── bill-upload-job.js     Upload Bill to IREPS: the worker job (BILL_UPLOAD_* messages, state)
│   ├── bill-tab-request.js    injected into the IREPS tab: bill calls, IREPS signer, save.php
│   ├── keep-alive.js          holdWorker: keeps the service worker running while a job runs
├── popup/                     the side panel
│   ├── popup.html  popup.css  popup.js
│   ├── popup-common.js        fillSelect (shared by the views)
│   ├── popup-gate.js          which view a tab gets (IREPS mock / real / other)
│   ├── popup-documents.js  popup-ma.js  popup-po-ic.js  popup-po-ic-batch.js  popup-downloads.js
│   ├── popup-redownload.js    "download again?" prompt
│   ├── popup-bill-upload.js   Upload Bill to IREPS view (section 20)
│   └── popup-recon-auth.js    Recon Engine sign-in page + RECON pill (login 2)
├── tender/                    Download Tender Documents + Correspondence (run in the side panel)
│   ├── tender-ui.js  pending-ui.js  view-common.js  run-lock.js  tender.css
│   ├── tender-core.js         fetch wrapper, errors, read-only guard, IREPS paths, text-PDF fallback, log
│   ├── tender-print.js        page-view letters printed to PDF by Chrome (chrome.debugger)
│   ├── tender-account.js      active account + startTenderJob
│   ├── tender-workflows.js  tender-auto.js  tender-jobs.js  tender-pending.js
│   ├── tender-search.js  tender-messages.js  tender-ledger.js  tender-ecm.js
│   └── tests/                 node:test suites + FakeIreps (jsdom: a devDependency, npm install)
├── services/
│   ├── search-po/             PO Search core: api, form, table, service, export, document-downloader
│   ├── bill-upload/           Upload Bill to IREPS (section 20): bill-upload-api, bill-form, bill-rules,
│   │                          bill-upload-service, bill-upload-store, ecm-invoice, invoice-file,
│   │                          tab-transport, bill-document-upload
│   ├── crn/  rnote/  ma/  po/ per-type parser / export / service (po/: po-date-service.js)
│   ├── inspection-certificate/  ic-api, ic-form, ic-parser, ic-search (runIcSearch), ic-service,
│   │                          ic-date-service, ic-notification-service
│   ├── notifications/         IREPS main-page notifications (IC issued)
│   ├── batch-download.js      download/state/retry half shared by the batch workflows
│   ├── batch-utils.js         transient-failure retry, DD/MM/YYYY ranges, readDateSelection
│   ├── ireps-form-lock.js     withIrepsFormLock: one IREPS form sequence (token) at a time
│   ├── export-save-service.js export -> Downloads or Recon Engine, with the download-log check
│   ├── ireps-api.js  ireps-form.js  session-service.js  bill-status-service.js  bill-parser.js  bill-status-export.js
│   ├── recon-service.js  recon-auth.js   Recon Engine (S3) + sign-in (login 2)
│   ├── ecm-service.js  ecm-direct.js  ecm-config.js  ecm-catalog.js   ECM (gateway or Nuxeo)
│   ├── download-log.js        what was downloaded, per user and destination
│   ├── pdf-service.js  download-service.js
├── utils/
│   ├── config.js              config.json + config.local.json (the only reader)
│   ├── dates.js               panel date helpers (local time)
│   ├── logger.js  messages.js (error catalogue, describeError)  sanitizer.js  filename.js
│   ├── url-scope.js  ireps-account.js  xlsx-writer.js  zip-writer.js
│   ├── http.js                fetchWithDeadline (Recon Engine, ECM, download log)
├── pages/                     preview.html / preview.js / preview.css
├── assets/                    icon16/32/48/128.png, logo.png
├── scripts/build.mjs          shareable build (dist/doclink + zip)
├── scripts/run-tests.mjs      npm test: every suite, on any OS
├── eslint.config.js           npm run lint
└── test/
    ├── run-tests.html / run-tests.js   browser suite (imports every *-tests.js)
    ├── *-tests.js             crn, rnote, ma, po, ic, batch, recon, recon-auth, ecm, ecm-direct,
    │                          download-log, export-save, bill-upload, sanitizer
    ├── node/                  node:test suites (npm test -- node)
    ├── make-sample-pdf.mjs
    ├── mock/                  mock IREPS server (http://localhost:8765) + target switch; bill upload:
    │                          mock-bill-upload.mjs, mock-bill-screens.mjs + bill-entry-page.html
    │                          (test hub /mock/bill/), bill-flow-check.mjs, sample_upload.json, sample.pdf
    └── fixtures/              captured / invented IREPS pages
```

---

## 4. Required permissions

| Permission | Why |
|---|---|
| `downloads` | Save the Bill Status workbook (.xlsx) into `Downloads/DocLink/IREPS/`, the CRN / R-NOTE exports (.xlsx/.csv) into `Downloads/DocLink/IREPS/CRN/` and `.../RNOTE/`, and the MA copies into `.../MA/<date>/`, and open the folder |
| `storage` | `chrome.storage.local` for non-sensitive metadata (last download time, filename, record count); `chrome.storage.session` (memory only) for job state and the last parsed result used by the preview |
| `unlimitedStorage` | Lifts the 10 MB limit of `chrome.storage.local`, so the tender ledger (what was downloaded, per tender) keeps growing instead of silently no longer being saved |
| `tabs` | Read the active tab's URL so the side panel can tell IREPS (mock or real) from any other site and show the right view (`popup/popup-gate.js`); opening IREPS / the preview page itself needs no permission |
| `offscreen` | Create an invisible offscreen document so the parser can use `DOMParser`; MV3 service workers have no DOM |
| `sidePanel` | DocLink's UI is Chrome's side panel, one per tab (`popup.html?tabId=<id>`); the toolbar icon opens and closes it (`chrome.sidePanel.setOptions` / `setPanelBehavior` in the service worker) |
| `identity` | Only for **Sign in with Okta** to the Recon Engine (section 17): `chrome.identity.launchWebAuthFlow` opens the Okta sign-in window and returns to `https://<extension id>.chromiumapp.org/okta` |
| `scripting` | Only for **Upload Bill to IREPS**: the supplier bill calls (`/epsn/ct/*`) are sent from inside the user's IREPS tab (`services/bill-upload/tab-transport.js`), so they leave from the portal's own origin like the bill page's own requests. Nothing is injected into other sites |
| `alarms` | Only for **scheduled downloads** (section 23): one alarm (`doclink.scheduler`) wakes the worker at the next check the Recon Engine names (09:00, 09:10, …). The alarm only asks the Recon Engine what is due; it never sends anything to IREPS |
| `debugger` | Only for **published letters and corrigenda** (LOA, Negotiation, Counter Offer, Correspondence, Corrigendum - in Download Tender Documents and Correspondence): IREPS builds each one as a web page on every view (there is no file to download), so DocLink prints it to PDF with Chrome's own Ctrl+P engine (`Page.printToPDF`, `tender/tender-print.js`) in a background tab that is closed straight after. Chrome shows "DocLink started debugging this browser" while a letter prints. If the permission is blocked by policy, the letter is saved as before (text-only PDF + original `.html`) with a warning |
| host `https://www.ireps.gov.in/*` and `http://localhost:8765/*` (both in `manifest.json`; a production build keeps only the real portal, section 9) | Lets the extension `fetch()` IREPS (viewBills.do, searchPO.do, vendorInspectionCallList.do, same origin) with the user's cookies attached by Chrome. Which one is actually used is `config.json`'s `"target"` ("mock" or "real") - a plain hand-editable file, no manifest change or command needed to switch |
| host `http://localhost:8000/*` and `https://wabtec.reconalpha-staging.joulestowatts.com/*` (the Recon Engine, local and staging; add the deployed Recon URL; a production build drops the localhost one) | The Recon Engine sign-in (section 17), the download log (section 18) and the **Save to: ECM / S3** uploads, with the Recon Engine's own sign-in cookie, without CORS. Must match `config.json` `reconBaseUrl` |
| host `http://wctsrvecmtstsn1.wabtec.com:8080/*` (the ECM test server) | Only for **Save to: ECM / S3** with `"ecmBackendAws": false`: DocLink calls the ECM (Nuxeo) directly. Must match `config.json` `ecm.domain`. A production build keeps it and warns that it is plain HTTP |

Not requested: `cookies`, `<all_urls>`, `history`, `bookmarks`, `webRequest`.
The extension never reads cookie values.

---

## 5. How IREPS session handling works

DocLink does not track a session id. "Logged in" means one thing only: IREPS
answered the authenticated request with the Bill Status page.

`services/session-service.js`:

* `checkIrepsSession()` performs `POST /epsn/admin/viewBills.do` (empty body)
  and validates the HTML.
* `validateIrepsSession(html, response)` returns `{ authenticated, reason, code }`
  with codes `OK`, `IREPS_SESSION_EXPIRED`, `IREPS_REQUEST_FAILED`,
  `IREPS_INVALID_RESPONSE`.
* `hasBillStatusForm(html)` is the strong check: the page must contain
  `<form name="vendorPartyCodeForm" action="/epsn/admin/viewBills.do">`.
* `isIrepsLoginPage(html)` looks for session-expired phrases, a password
  input, a redirect to a login-looking URL, or login vocabulary in the absence
  of bill data.

HTTP 200 is never trusted on its own: IREPS may return a login page with 200.
Any request in the flow can hit an expired session; the second (search)
response is validated exactly like the first.

The session check result is cached for 20 seconds in service-worker memory so
that opening the popup and clicking Download does not hit IREPS twice; the
page is handed to the download once and then discarded. Cookies are never
read: Chrome attaches them because the extension has host permission for the
IREPS origin and the requests use `credentials: "include"`.

---

## 6. How the Bill Status request works

Captured from the real portal (HAR) and implemented in `services/ireps-api.js`
and `services/bill-status-service.js`:

```
1. POST https://www.ireps.gov.in/epsn/admin/viewBills.do
   Content-Type: application/x-www-form-urlencoded
   (empty body)
   -> HTML: vendorPartyCodeForm, hidden org.apache.struts.taglib.html.TOKEN,
      <select name="zone"> (-1 = All, 01 = CR, 13 = ICF, ...),
      searchRange radios (3 Railway Zone, 2 Select Date, 1 Last 90 Days [default]),
      dateFrom / dateTo, submit "Show Results", hidden searchParam,
      and the default bill blocks

2. POST https://www.ireps.gov.in/epsn/admin/viewBills.do
   Content-Type: application/x-www-form-urlencoded
   org.apache.struts.taglib.html.TOKEN=<token from step 1>
   &zone=-1&searchRange=1&dateFrom=&dateTo=&submit=Show+Results&searchParam=
   -> HTML: one <table id="table_id"> per bill
```

Only `Accept` and `Content-Type` are set by DocLink; Cookie, Origin, Referer,
User-Agent, Sec-Fetch-* etc. are generated by Chrome. `/epsn/searchPO.do`
(seen in another capture) is a different workflow and is not used.

Public API:

```javascript
import { fetchBillStatus } from "./services/bill-status-service.js";

await fetchBillStatus({ mode: "last90Days", zone: "-1" }, { parseHtml });
await fetchBillStatus({ mode: "dateRange", zone: "-1", dateFrom: "01/08/2026", dateTo: "31/08/2026" }, { parseHtml });
await fetchBillStatus({ mode: "railwayZone", zone: "13" }, { parseHtml });
// -> { success: true, request: { mode, zone, ... }, filter, fetchedAt, recordCount, bills, warnings, form: { zones, searchRanges }, parsed }
```

`parseHtml` is injected because the service worker has no DOMParser (it
forwards to the offscreen document; tests pass `parseBillStatus` directly).

Constants (never magic numbers in the code):

```javascript
BILL_SEARCH_RANGE = { LAST_90_DAYS: "1", DATE_RANGE: "2", RAILWAY_ZONE: "3" }
BILL_SEARCH_MODE  = { LAST_90_DAYS: "last90Days", DATE_RANGE: "dateRange", RAILWAY_ZONE: "railwayZone" }
ALL_ZONES = "-1";  MAX_DATE_RANGE_DAYS = 180
```

Date-range requests are validated before anything is sent, with the same
rules as the IREPS page script (both dates, DD/MM/YYYY, From ≤ To, ≤ 180 days).

### Struts TOKEN handling

* The token is read from the returned HTML by `services/ireps-form.js`
  (`extractStrutsToken`) - never hard-coded.
* It lives only in local variables inside `fetchBillStatus()` for the duration
  of the request; it is not logged (the logger redacts `TOKEN=` anyway), not
  stored, and not part of any result, message or PDF.
* A page without the token is not an error: DocLink logs "token present:
  false" and sends the search without the TOKEN field. The Bill Status flow
  also logs the structure of the form and result pages (table / form counts,
  hidden-field names, a few text markers - never values) to help diagnose
  portal changes.
* The token is single-use per page render. If the search response is not the
  Bill Status page (for example the user reloaded IREPS in another tab and
  consumed the token), DocLink loads the page once more, takes the fresh token
  and retries once (only when the first page had a token). A second failure →
  `IREPS_INVALID_RESPONSE`.

### Error codes

| Code | When | Popup |
|---|---|---|
| `IREPS_SESSION_EXPIRED` | login page / session-expired page / redirect to login (either request) | "IREPS login required" view |
| `IREPS_REQUEST_FAILED` | network error, timeout, HTTP ≠ 2xx | "Unable to retrieve Bill Status" |
| `IREPS_INVALID_RESPONSE` | page is neither login nor Bill Status (after one retry) | "Unable to load Bill Status" |
| `IREPS_PARSE_FAILED` | blocks present but unreadable, or parser crashed | "Unable to read the Bill Status records" |
| `IREPS_NO_RECORDS` | authenticated page, zero blocks | "No Bill Records Found" (notice) |
| `IREPS_INVALID_REQUEST` | bad mode / invalid date range | "Invalid search options" (notice) |
| `EXPORT_ERROR` | the Excel file could not be built | "Bill Status Retrieved - However, DocLink could not create the Excel file." |

---

## 7. How parsing works

`services/bill-parser.js` — `parseBillStatus(html, { filter })`:

1. Parse with `DOMParser` into a detached document; strip `script`, `style`,
   `iframe`, forms, media, event handlers and `javascript:` URLs.
2. `document.querySelectorAll("table#table_id")` — the id is repeated for every
   bill, so `querySelector` would only return the first.
3. `parseBillBlock(table)` classifies rows by content, never by position:
   * a row whose cells are all field labels (e.g. `Contract No | Contract Date |
     Bill Number | Bill Date | Zone | Party Name | PartyCode`, or `CO6 No |
     CO6 Date | Status | Bill Amt | Passed Amt | Deducted Amt | Net Amt | CO7 No |
     CO7 Date | Payment Advice Date to Bank | Accounting Unit(Division)`) is a
     header; the next row holds the values, mapped column by column;
   * a single-cell `Reason For Return` / `Recovery Details` row is a section
     header; the next row's complete text is stored (`<br>` → newline, nested
     tables → one line per row);
   * `Label | value` cell pairs are read as key/value; nested tables are walked
     with the same rules.
   Labels are normalised ("Accounting Unit(Division)" → `accountingunit`) and
   matched against alias lists (`Payment Advice Date to Bank` →
   `paymentAdviceDate`, `PartyCode` → `partyCode`).
4. `normalizeIrepsValue()` turns `----`, `-`, `NA`, `N/A` and empty cells into
   `null`; every other value is kept verbatim as a string (amounts are not
   converted, nothing is calculated).
5. `validateBillStatusRecords()` keeps every block that has a Bill Number
   and/or a Contract No, sets aside the rest, and produces warnings such as
   "Bill record 47 is missing Bill Number.". Nothing is de-duplicated: a bill
   appears once per lifecycle status (REGISTERED, RETURNED, PASSED, PAYMENT
   MADE, CO7 DONE, ...) exactly as IREPS lists it.
6. If no `table#table_id` exists, the legacy single-table / key-value parsers
   are tried (kept for older layouts).

Result:

```javascript
{
  title: "IREPS Bill Status",
  generatedAt, retrievedAt, source: "IREPS", sourceUrl,
  filter: "Last 90 Days, All Zones",
  recordCount: 2129, blockCount: 2129, skippedCount: 0,
  bills: [ { index, contractNo, contractDate, billNumber, billDate, zone,
             partyName, partyCode, co6No, co6Date, status, billAmount,
             passedAmount, deductedAmount, netAmount, co7No, co7Date,
             paymentAdviceDate, accountingUnit, recoveryDetails,
             reasonForReturn, extra: {} } ],
  extraColumns, structure: "blocks" | "table" | "keyValue" | "none",
  pageMessage, warnings, printableHtml
}
```

Verified against the captured real page (6.8 MB, 2,129 blocks): 2,129
records, 0 skipped, all 20 fields populated where IREPS shows them.

---

## 8. How PDF generation works

`services/pdf-service.js` writes the PDF directly (no library, no backend,
no screenshots):

* A4 portrait, Helvetica / Helvetica-Bold (standard PDF fonts, text is
  selectable and searchable).
* Title block with Source / Retrieved / Filter / Records.
* One card per bill: two label/value columns, long fields (Party Name,
  Accounting Unit, Recovery Details, Reason for Return, extra columns)
  full-width and word-wrapped.
* Cards move to the next page when they do not fit; cards taller than a page
  split at row boundaries; a single row taller than a page splits by line
  with its label repeated and the header marked "(continued)".
* Running header and "Page X of Y" footer on every page.
* Streams are Flate-compressed with `CompressionStream` when available.

`generateBillStatusPdf(result)` → `{ bytes, pageCount }`. The bytes are
handed to `chrome.downloads.download` as a `data:` URL (service workers have
no `URL.createObjectURL`).

Fallback: if PDF generation or the download fails, the popup offers
**Open printable preview** (`pages/preview.html`), which renders the same
data from `chrome.storage.session` and provides **Download PDF** (in-page
generation) and **Print / Save as PDF**.

---

## 9. Loading the unpacked extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the repository folder (the one with `manifest.json`)
5. Login to IREPS at https://www.ireps.gov.in/ with your normal security key
6. Open DocLink from the toolbar
7. Click **Download Bill Status**

Requires Chrome 116 or newer (offscreen documents + `chrome.runtime.getContexts`).

### Building a shareable zip (dist)

`scripts/build.mjs` produces a protected copy of the extension for sharing.
Each JS entry point (`background/service-worker.js`, `background/offscreen.js`,
`pages/preview.js`) is bundled with its imports, minified and obfuscated. The
three side-panel scripts (`popup/popup.js`, `tender/tender-ui.js`,
`tender/pending-ui.js`) load into the same page, so they are bundled together
with code splitting: the modules they share (download log, print queue,
diagnostics log) are emitted once under `chunks/`, exactly as when DocLink is
loaded unpacked. HTML, CSS, `assets/` and `config.json` are copied as-is;
`manifest.json` gets the build's `host_permissions` and `version_name`. Tests,
`scripts/`, `config.local.json` and the readable `services/` / `utils/` sources
are not included. The source tree is never modified.

There are two kinds of build:

| | `npm run build` (production) | `npm run build -- --allow-mock` (test build) |
|---|---|---|
| `config.json` `"target"` | must be `"real"` | anything |
| A `config.json` URL DocLink uses (IREPS, `reconBaseUrl`, `reconAppUrl`, `ecm.domain` in direct mode) on this PC (`localhost`, `127.0.0.1`) | stops the build | allowed |
| `host_permissions` of the built manifest | those of `manifest.json` without `localhost` and the mock portal; the build stops if what is left does not cover a URL DocLink sends requests to, and warns about a plain-HTTP one (the ECM test server) | as in `manifest.json`, so the copy can be pointed at the mock portal and a local Recon Engine |

Every build also:

* stops when `config.json` holds what looks like a real credential (a secret
  such as `ecm.clientSecret`, a password, an API or private key, an access or
  refresh token, of 8 characters or more; the shipped `"abc"` placeholders
  pass). Real credentials belong in `config.local.json`, which is never
  packaged;
* warns when ECM documents would go straight to the ECM
  (`"ecmBackendAws": false`) with placeholder client credentials;
* logs from `info` up (DocLink loaded unpacked logs from `debug`;
  `-- --log-level=debug` makes a build that does too);
* stamps the git commit into the built manifest's `version_name`, which
  `chrome://extensions` shows (`1.5.0 (97185b8)`; `-dirty` when the tree had
  uncommitted changes, `test build` for `--allow-mock`), and into
  `build-info.json`;
* obfuscates with a fixed seed: the same sources and `package-lock.json` give
  the same files.

Requirements: Node.js 22.22+ or 24.15+ (the test tools need it),
and the `zip` command (preinstalled on macOS and Linux;
on Windows any `zip.exe` on the PATH).

```bash
# 1. Install the build and test tools (esbuild, javascript-obfuscator, ESLint, jsdom) - once
npm install

# 2. Before building:
#    - config.json  -> "target": "real" for users ("mock" only for local testing)
#    - manifest.json and package.json -> raise "version" for a new release (e.g. "1.5.0");
#      Chrome accepts 1-4 dot-separated numbers

# 3. Build
npm run build
```

Output:

```
dist/doclink/                                unpacked build (load this in Chrome to check it)
dist/doclink/build-info.json                 version, commit, kind of build, target, log level
dist/doclink-<version>-<YYYYMMDD-HHMMSS>.zip  the file to share ("version" from manifest.json)
```

`npm run build` deletes and recreates `dist/doclink/` every run; earlier zips
in `dist/` are kept. `dist/` is git-ignored and should not be edited by hand.

The recipient unzips the file, opens `chrome://extensions`, enables
**Developer mode**, clicks **Load unpacked** and selects the unzipped
`doclink/` folder. To update, they replace the folder with the new build and
click the reload icon on the DocLink card.

---

## 10. Testing

### Automated tests (no extension APIs required)

The commands work on Windows, macOS and Linux. `npm install` once first
(jsdom, ESLint and the build tools are devDependencies, never shipped in the
extension).

```bash
# Every suite: the browser suite in headless Chrome (parsers, flows with a fake IREPS, sanitiser,
# logger redaction, writers, ECM, download log, ...), the tender / correspondence / panel
# node:test suites, and the bill-flow check (its own mock on port 8799). Exit code 0 = all passed.
npm test
npm test -- browser                    # → DOCLINK_TESTS <n>/<n> passed
npm test -- browser --only=po,ic       # only some browser suites (names in test/run-tests.js; "core" = run-tests.js itself)
npm test -- node                       # → NODE_TESTS <n>/<n> passed
npm test -- bill                       # → BILL_FLOW_CHECK passed

npm run lint                           # ESLint (eslint.config.js): undefined names, duplicate keys, unreachable code, ...
npm run verify                         # lint + every test + the production build: run it before every pull request

# One node:test file, or one test by name
node --test tender/tests/run-tests.mjs
node --test --test-name-pattern="ECM direct" tender/tests/run-tests.mjs

# Sample PDF for visual inspection
node test/make-sample-pdf.mjs sample.pdf
```

Chrome is found at its usual install path (or set `CHROME_PATH`); each run uses
a throwaway Chrome profile. You can also open `test/run-tests.html` in Chrome
started with `--allow-file-access-from-files`.

### Testing without access to IREPS (mock portal)

`test/mock/mock-ireps-server.mjs` is a local stand-in for the portal. It
serves the same path (`/epsn/admin/viewBills.do`), issues a fresh fake Struts
token per page, requires the exact form fields on the search POST (single-use
token), simulates the security-key login by issuing the portal's own session
cookies (`JSESSIONID` in the WebSphere format seen in the captures, plus the F5
`TS01b82797` cookie; values random, tracked server-side), serves the captured
home / logout paths (`/epsn/home/showHome.do`, `/epsn/home/logout.do`), renders its
pages in the IREPS look (the portal's real stylesheet, images and jQuery are served
from `test/mock/static/` at their portal paths; the Bidder Home Page and login page
are modelled on the captured layout with fictitious data), keeps its test scenarios
on a separate control panel (`/mock/`), and can be switched
between scenarios (`auto`, `bills`, `large`, `login`, `redirect-login`,
`expired`, `no-records`, `token-missing`, `token-invalid`, `http500`, `slow`,
`legacy`) from its home page.

```bash
node test/mock/mock-ireps-server.mjs        # terminal 1, http://localhost:8765
# set "target": "mock" in config.json (or: node test/mock/switch-target.mjs mock)
# chrome://extensions -> reload DocLink
# open http://localhost:8765/ -> Login -> open DocLink -> Download Bill Status
# set "target": "real" in config.json before real use (or: node test/mock/switch-target.mjs real)
```

Both origins are declared in `manifest.json`, so `config.json`'s
`"target"` field is the only thing that ever needs to change to switch
between the mock and the real portal - editing it by hand and reloading the
extension works exactly like running `switch-target.mjs`. (A production build
keeps only the real portal; a `--allow-mock` build keeps both, section 9.)

### Manual acceptance tests

| # | Scenario | Expected |
|---|---|---|
| 1 | Logged into IREPS, click Download Bill Status | Stages run through; "✓ Download Complete", N records, filename shown; .xlsx in `Downloads/DocLink/IREPS/` |
| 2 | Logged out | No file; "IREPS Login Required" view with Open IREPS button |
| 3 | Session expired (login page returned with HTTP 200) | "IREPS Session Expired"; no file built from the login page |
| 4 | IREPS returns HTTP 5xx (e.g. simulate with DevTools request blocking / override) | "Unable to Retrieve Bill Status — IREPS returned HTTP 500"; button usable again |
| 5 | Very large Bill Status | All rows in the workbook (browser test covers 600 rows in the PDF writer) |
| 6 | Bills with missing fields | Missing values shown as "-" |
| 7 | Long Recovery Details | Text wraps, splits across pages with label repeated |
| 8 | Download twice | Two files (timestamp differs; same-second collisions get " (1)") |

Simulating 2–4 locally: use DevTools → Network → request blocking or a local
override of `viewBills.do` with `test/fixtures/login-page.html`,
`session-expired.html`, or a 500 response.

---

## 11. Security notes

* No IREPS credential, cookie, token or session id is read, stored, logged or
  put in a URL. The one credential DocLink handles is the Recon Engine
  password typed on its sign-in page (section 17): it is sent once to
  `reconBaseUrl` and dropped - never stored, logged or read back. The Recon
  session cookie that answer sets is httponly and stays in Chrome's own
  cookie jar; DocLink never reads it. The Okta client secret is never in the
  extension: the Recon backend exchanges Okta's code. The Struts TOKEN is held in memory only for the duration of one
  request. The logger (`utils/logger.js`) additionally redacts anything that
  looks like `Cookie:`, `JSESSIONID=`, `Authorization:`, a token (also in JSON
  and the Struts token field of a page), a client secret, an API key or a password.
* Network calls are restricted to `IREPS_CONFIG.baseUrl`; `buildIrepsUrl`
  refuses any other origin. When `config.json` cannot be read, or has no
  valid `"target"` (`"mock"` or `"real"`), there is no IREPS URL at all:
  nothing is sent (`IREPS_NOT_CONFIGURED`) and the panel shows "DocLink
  configuration error", never the mock portal in its place.
* IREPS HTML is parsed in an offscreen document into a detached DOM and
  never inserted into an extension page. Popup and preview build their DOM
  from structured data with `textContent`.
* Manifest CSP: `script-src 'self'; object-src 'none'`.
* Only business metadata (last download time, filename, record count, status)
  is stored in `chrome.storage.local`. The parsed bill data for the preview
  lives in `chrome.storage.session` (memory, cleared when Chrome closes).

---

## 12. Assumptions and known limitations

### Assumptions

* `POST /epsn/admin/viewBills.do` with an empty body returns the Bill Status
  page with a fresh Struts token for an authenticated session (as captured).
  Submitting `TOKEN + zone=-1 + searchRange=1 + submit=Show Results` to the
  same URL returns the Last 90 Days records for all zones.
* The exact HTML IREPS returns for "no records" and for an expired session was
  not in the capture. An authenticated page with the form but zero
  `table#table_id` blocks is reported as `IREPS_NO_RECORDS`; login pages are
  detected by password fields / login vocabulary / session-expired phrases.
* Struts token reuse: if IREPS rejects a consumed token with a page that is
  neither login nor Bill Status, DocLink retries once with a fresh token.
* Amounts are kept as the strings IREPS prints (e.g. `2968191.9`); a Bill
  Number of `-` is treated as missing (IREPS prints it for some RETURNED bills).
* Fetches from the extension carry `Origin: chrome-extension://…`. Struts does
  not check Origin; if the portal's edge (F5) ever rejects it, a
  `declarativeNetRequest` header rule would be the next step.
* Times in filenames and the PDF are the user's local time.

### Known limitations

* Standard PDF fonts cover Latin-1 only. `₹` is rendered as "Rs.", typographic
  dashes/quotes as ASCII, and other scripts (e.g. Devanagari) as "?". The
  parsed data and the HTML preview keep the original characters.
* The session check loads the full Bill Status page (~7 MB on the real
  portal; there is no lighter IREPS endpoint); the result is cached for 20 s.
* Recovery Details is stored as the complete text ("GST TDS DEDUCTION: …\n…");
  structured deduction categories are not extracted yet.
* Save to ECM / S3 needs the Recon Engine sign-in (section 17). Okta sign-in
  works only once DocLink's redirect is registered in the Okta app.

### Upload (Phase 2)

The Phase 2 placeholder (`services/upload-service.js`, the Source / Document /
Type form) is replaced by **Upload Bill to IREPS**, section 20. Scheduled runs
and automatic login stay out of scope. Saving IREPS exports to the Recon Engine
(S3) is a download destination, not part of the upload (section 15).

---

## 13. PO Search downloads: CRN and R-NOTE

CRN and R-NOTE are two document types of the same IREPS *PO Search*
workflow, which is separate from Bill Status and never touches `viewBills.do`:

```
Bill Status  ->  POST /epsn/admin/viewBills.do        (sections 5-8)   -> generated PDF
CRN          ->  POST /epsn/searchPO.do  searchCriteria=CRN            -> Excel export of the result table
R-NOTE       ->  POST /epsn/searchPO.do  searchCriteria=RNOTE          -> Excel export of the result table
```

On the portal the result page (PO Search → *Consignment Receipt Note (CRN)*
or *Receipt Note (R-NOTE)* → Show Results) is a DataTables grid showing 10
rows at a time with an **Export to Excel** button. DocLink reproduces that
export from the server response itself, so all rows (2,022 CRNs in the
capture) are included, not just the visible page. DocLink's download layer
is format-agnostic: the export is an `.xlsx` workbook by default, `.csv`
optionally; nothing in the flow assumes a PDF.

### Shared layer (services/search-po/)

```
               IREPS PO Search (/epsn/searchPO.do)
                            │
        search-po-api / -form / -table / -service / -export
                            │
              ┌─────────────┴─────────────┐
             CRN                        R-NOTE
      searchCriteria=CRN           searchCriteria=RNOTE
      crn-parser.js                rnote-parser.js
      crn-export.js                rnote-export.js
      IREPS_CRN_<ts>.xlsx          IREPS_RNOTE_<ts>.xlsx
```

Shared: endpoint, POST, authenticated session (`credentials: "include"`),
`searchParam=showPage`, Struts token extraction, railway list, PO / date /
searchRange / pageNo / recordsPerPage handling, 180-day validation,
pagination, single fresh-token retry, session-expiry handling, Excel/CSV
writing. Different: `searchCriteria`, the result parser, the export columns,
the file name and the error codes (`IREPS_CRN_*` vs `IREPS_RNOTE_*`).

### Flow

```
User logs into IREPS normally (security key)                      <- unchanged, manual
        ↓
DocLink popup -> Download IREPS CRN  (or Download IREPS R-NOTE) -> Download
        ↓
POST /epsn/searchPO.do        searchParam=showPage          (credentials: "include")
        ↓  "PO Search" page: <form name="searchPOForm">, fresh Struts TOKEN, railway list
DocLink validates the page (login page? expired? searchPOForm present?)
        ↓
POST /epsn/searchPO.do        TOKEN + pageNo=1 + searchCriteria=CRN|RNOTE + rly + poNo + icNo
                              + dateFrom + dateTo + searchRange + recordsPerPage
                              + submit=Show Results + searchCriteria=        (see below)
        ↓  HTML: <table id="table_id"> > <table id="dTbl"> with one row per document
type-specific parser: header-driven mapping, links classified
        ↓  server-side page links present?  -> every page is fetched (never only page 1)
export: Excel workbook (data sheet + sheet "Info") or CSV
        ↓
Saved as Downloads/DocLink/IREPS/CRN/IREPS_CRN_YYYY-MM-DD_HH-mm-ss.xlsx
      or Downloads/DocLink/IREPS/RNOTE/IREPS_RNOTE_YYYY-MM-DD_HH-mm-ss.xlsx
```

### The exact request (from the captured HAR; R-NOTE differs only in the criteria)

```
POST https://www.ireps.gov.in/epsn/searchPO.do
Content-Type: application/x-www-form-urlencoded

org.apache.struts.taglib.html.TOKEN=<fresh token from the showPage response>
&pageNo=1
&searchCriteria=CRN            <- RNOTE for Receipt Notes
&rly=-1
&poNo=
&icNo=
&dateFrom=
&dateTo=
&searchRange=1
&recordsPerPage=20
&submit=Show+Results
&searchCriteria=
```

`searchCriteria` appears twice because the IREPS form has a `<select
name="searchCriteria">` (`CRN` / `RNOTE` / …) **and** a trailing hidden
`<input name="searchCriteria">` that is empty. `buildSearchPoRequest()`
builds the body with `URLSearchParams.append()` in exactly this order.

Form semantics (labels confirmed from the page HTML):

| Field | Values |
|---|---|
| `searchCriteria` | `<option value="CRN">Consignment Receipt Note (CRN)</option>`, `<option value="RNOTE">Receipt Note (R-NOTE)</option>` (also PO, DRR, MA, Rej, CRC, Conversation - not implemented) |
| `rly` | `-1` = All, otherwise the railway code from `<select name="rly">` (read from the page, never hard-coded) |
| `searchRange` | `3` = PO No. (needs `poNo`), `2` = Select Date (`dateFrom`/`dateTo`, DD/MM/YYYY, ≤ 180 days), `1` = Last 180 Days (default, the captured request) |
| `pageNo` / `recordsPerPage` | `1` / `20` in the captured request; `recordsPerPage` is a free text field and the portal accepted `2000` in another capture |
| `poNo`, `icNo`, `dateFrom`, `dateTo` | empty unless the corresponding mode is used |

Public API:

```javascript
import { searchIrepsDocuments } from "./services/search-po/search-po-service.js";
import { searchCrn } from "./services/crn/crn-service.js";
import { searchRnote } from "./services/rnote/rnote-service.js";
import { buildCrnExport } from "./services/crn/crn-export.js";
import { buildRnoteExport } from "./services/rnote/rnote-export.js";

// generic (the service worker uses this; parseHtml is routed by criteria in the offscreen document)
const result = await searchIrepsDocuments({ criteria: "RNOTE", railway: "-1", pageNo: 1, recordsPerPage: 20 }, { parseHtml });
// -> { success: true, criteria: "RNOTE", documentType, search: { criteria, mode, railway, pageNo, recordsPerPage, pagesFetched },
//      filter, fetchedAt, recordCount, records, headerLabels, warnings, form, pagination }

// typed wrappers (default parser included)
await searchCrn({ poNo: "RR-PR-WC-2034-25-26-04" });                                        // searchCriteria=CRN, searchRange=3
await searchRnote({ dateFrom: "01/08/2026", dateTo: "31/08/2026", railway: "01" });         // searchCriteria=RNOTE, searchRange=2

const file = buildRnoteExport(result);                   // { bytes, mimeType, extension: "xlsx", recordCount, columnCount }
const csv = buildCrnExport(crnResult, { format: "csv" });
```

### CRN records and export

Parsed CRN record (values verbatim; `nil`, `NA`, `----` and empty cells → `null`):

```javascript
{
  index: 1, id: "crn-1",
  poNo: "RR-PR-WC-2034-25-26-04", poDate: "31/01/2026",
  challanNo: "SSE.LHB.LTT.WAR.FAIVELEY", challanDate: "12/09/2026",
  crnType: "Warranty Replacement", claimNo: "013833-26-10276",
  railway: "CR", poSerial: "143",
  crnNo: "013833-26-23416", crnDate: "12/09/2026", approvalDate: "18/09/2026", crnQty: "1",
  billClaimStatus: "Not For Payment",
  billRegNo: null, billRegSignDate: null, invoiceNo: null, invoiceDate: null,
  co6No: null, co6Date: null, co7No: null, co7Date: null,
  claimAmount: null, passedAmount: null, paymentOrReturnDate: null, returnReason: null,
  crnPdfUrl:   "https://www.ireps.gov.in/ireps/etender/ct/MMIS/CONS/2026/01/…/013833-26-23416_2.pdf",
  claimPdfUrl: "https://www.ireps.gov.in/ireps/etender/ct/MMIS/CRC/WAR/2026/01/…/013833-26-10276.pdf",
  billPdfUrl:  null,
  extra: {}
}
```

Sheet **CRN** (bold, frozen header with auto-filter), one row per CRN:

```
# | PO No. | PO Date | Challan No. | Challan Date | CRN Type | Claim No. | Rly | PO Sr | CRN No. | CRN Date |
Approval Date | CRN Qty | Bill Claim | Bill Reg No. | Bill Reg/Sign Date | Invoice No. | Invoice Date |
CO6 No. | CO6 Date | CO7 No. | CO7 Date | Claim Amount | Passed Amount | Payment / Return Date | Return Reason
```

The columns follow the captured IREPS table in order, like the portal's own
Export to Excel; the combined "CRN Type / Claim No." cell is split into two
columns. The document links IREPS embeds in the table (`crnPdfUrl`,
`claimPdfUrl`, `billPdfUrl`) stay on the parsed records but are not
exported.

### R-NOTE records and export (layout not captured yet)

What is confirmed: R-NOTE is `<option value="RNOTE">Receipt Note (R-NOTE)</option>`
of the same searchPOForm with the same controls, so the request side is
identical to CRN apart from the criteria. What is **not** captured yet is an
R-NOTE result page. The R-NOTE parser therefore assumes nothing about the
columns or the document link path:

* the result table is located by its header row (a "R-Note No." style column
  must exist), never by position;
* every column is kept verbatim in `rawColumns` (header label → text) so no
  data is lost while the real layout is confirmed;
* well-known labels are also mapped to typed fields;
* every anchor of a row is kept in `links` (text, title, absolute URL,
  column), and the R-NOTE document link is chosen from them by header context
  (an anchor in the R-Note No. column) or anchor text/title ("R-Note",
  "Receipt Note") - never by the CRN's `/MMIS/CONS/` rule, and never a
  Manage PO / bill / acknowledgement link.

```javascript
{
  index: 1, id: "rnote-1",
  poNo: "RR-PR-WC-1001-25-26-01", poDate: "31/01/2026", railway: "CR", poSerial: "143",
  rnoteNo: "RN-013801-26-40001", rnoteDate: "10/09/2026",
  challanNo: "…", challanDate: "05/09/2026", invoiceNo: "4471", invoiceDate: "02/09/2026",
  quantity: "12", status: "Accepted",
  documentUrl: "https://www.ireps.gov.in/ireps/etender/ct/…/RN-013801-26-40001.pdf",   // href exactly as returned
  documentLink: { text, title, url, column: "R-Note No." },
  links: [ { text, title, href, url, column, key }, … ],                                // every anchor of the row
  rawColumns: { "#": "1", "PO No.": "…", "R-Note No.": "…", … }                         // every page column
}
```

Sheet **R-NOTE**: the page's own column labels in page order (from
`rawColumns`, Action column dropped), then `R-Note Document Link` and
`Other Links`. `test/fixtures/rnote-results-page.html` is a clearly marked
*assumed* layout (CRN page frame + plausible R-NOTE columns, fake
`/ireps/etender/ct/MOCK/RNOTE/…` links) used by the mock and the tests.
When a real R-NOTE result page is captured, compare it with the fixture; the
parser should already cope, and `RNOTE_HEADER_MAP` in
`services/rnote/rnote-parser.js` is where new labels get their typed field.

Sheet **Info** (both types): document, source, retrieval time, filter,
record count, result pages fetched, and any parser warnings.

The workbook is written by `utils/xlsx-writer.js` (Office Open XML, inline
strings so a 14-digit PO number is not turned into `7.02E+13`) on top of
`utils/zip-writer.js` (ZIP, store method, CRC-32) - no library, no backend.
CSV output is UTF-8 with BOM and CRLF line ends.

### Pagination

The captured CRN response returned all 2,022 rows in a single page (the
table is paged client-side by DataTables; IREPS printed no server page links
even with `recordsPerPage=20`). The MA search in the same capture *was*
paginated server-side with links of the form
`postRequest('/epsn/searchPO.do?rly=-1&dateFrom=&dateTo=&pageNo=2&searchRange=1&poNo=&count=1720&recordsPerPage=20')`.
The shared layer handles both: `extractSearchPoPagination()` detects such
links, and `searchIrepsDocuments()` re-posts each page's parameters exactly
like the portal's `postRequest.js` does (no token) until every page is
fetched. A partial list is never exported silently: a failing page fails the
download.

### Error codes

| Code | When |
|---|---|
| `IREPS_SESSION_EXPIRED` | login / expired page at any step |
| `IREPS_SEARCH_PAGE_FAILED` | showPage request failed (network/HTTP) or the response is not the PO Search page |
| `UNSUPPORTED_IREPS_SEARCH_TYPE` | a criteria other than CRN / RNOTE was requested |
| `IREPS_CRN_SEARCH_FAILED` / `IREPS_RNOTE_SEARCH_FAILED` | search request failed (network/HTTP) |
| `IREPS_CRN_RESULTS_INVALID` / `IREPS_RNOTE_RESULTS_INVALID` | search response not recognised (after one fresh-token retry), IREPS error message, or a missing result page |
| `IREPS_CRN_NOT_FOUND` / `IREPS_RNOTE_NOT_FOUND` | zero records for the search (notice) |
| `IREPS_CRN_PARSE_FAILED` / `IREPS_RNOTE_PARSE_FAILED` | rows present but unreadable / parser crashed |
| `IREPS_INVALID_REQUEST` | bad options (missing PO number, invalid date range, page size) |
| `DOCUMENT_EXPORT_ERROR` | records retrieved but the file could not be built |
| `DOCUMENT_DOWNLOAD_ERROR` | file built but Chrome could not save it |

### Security

The PO Search flows follow the same rules as Bill Status: no cookie,
JSESSIONID or token is read, stored, logged or sent anywhere. The Struts
token exists only in local variables inside `searchIrepsDocuments()`. With
Save to: Recon (S3), only the export file itself (the same .xlsx a local
download would save) is sent to the Recon Engine - never IREPS HTML, cookies
or tokens.

---

## 14. MA copies download (Modification Advice)

MA is the third document type on the PO Search page (`searchCriteria=MA`)
and reuses the whole shared layer of section 13. The difference is what is
downloaded: not the result table, but the **MA PDF copies** that IREPS links
from each row, grouped by MA date.

### Flow

```
DocLink popup -> Download MA -> MA Date (default today) [or range / all], Railway, optional PO -> Search MAs
        ↓
POST /epsn/searchPO.do  searchParam=showPage           (session check + fresh Struts TOKEN)
POST /epsn/searchPO.do  searchCriteria=MA  rly=-1  searchRange=1  pageNo=1  recordsPerPage=2000  submit=Show Results
        ↓  HTML: <table id="table_id"> > <table id="dTbl2">, one <tr class="trPoRow"> per MA
parseMaSearchResults(): Sr. No. | Dept / Rly. Unit | PO No. | PO Date | PO_SR | MA No. | MA Date | Action(s)
        ↓  server page links present? -> every page is fetched
DocLink keeps the rows whose "MA Date" matches the selection and lists them
        ↓  user: Download Selected / Download All
GET <href of a[title="View/Download MA"]>   with the browser session, 3 at a time, verified as %PDF-
        ↓
Downloads/DocLink/IREPS/MA/<YYYY-MM-DD of the MA date>/<IREPS file name, e.g. 07250369100001_007001.pdf>
```

### The captured MA request

Identical to the CRN request of section 13 with `searchCriteria=MA`. The
capture shows the portal paginating MA server-side at `recordsPerPage=20`
(1,838 results, 92 pages of `postRequest(...)` links) **and** accepting
`recordsPerPage=2000` with all 1,838 rows in one response. DocLink therefore
sends 2000 for MA by default and still follows page links if any appear.

The IREPS "Select Date" filter is **not** used for the MA date selection,
because the capture does not show whether it filters by PO date or MA date.
DocLink searches "Last 180 Days" and filters the parsed rows by the MA Date
column itself (a PO number, when entered, is sent to IREPS as `searchRange=3`).

### Parsed MA record (values verbatim; `null`, `nil`, `NA`, `----` → null)

```javascript
{
  index: 1, id: "ma-1",
  serialNo: "1", railwayUnit: "HQ/NR",
  poNo: "07250369105448", poDate: "20/07/2026", poSerial: null,
  maNo: "007327", maDate: "18/09/2026", maDateKey: "2026-09-18",
  poPdfUrl: "https://www.ireps.gov.in/ireps/etender/pdfdocs/MMIS/PO/2026/03/07250369105448.pdf",         // PO document
  maPdfUrl: "https://www.ireps.gov.in/ireps/etender/pdfdocs/MMIS/PO/2026/03/07250369105448_007327.pdf",  // MA copy
  links: [ { text, title, href, url, column, key }, … ],                 // every anchor of the row
  rawColumns: { "Sr. No.": "1", "Dept / Rly. Unit": "HQ/NR", … }
}
```

Link detection: the MA copy is the anchor with `title="View/Download MA"`
(anywhere in the row); the PO document is the anchor in the PO No. cell or
the one titled "Click to View/Download PO". "Manage Your Purchase Order"
(`href="#"`) and the acknowledgement link (`javascript:`) are never
documents. Hrefs are used exactly as returned; the
`/pdfdocs/MMIS/PO/<year>/<month>/<PO>_<MA>.pdf` pattern only triggers a
warning when it does not match.

### Download

`document-downloader.js` performs `GET` with `credentials: "include"` on
the IREPS origin only and checks the `%PDF-` signature. A login/expired
page answered with HTTP 200 becomes `IREPS_SESSION_EXPIRED` ("Your IREPS
session has expired. Please log in again and retry the MA download."), any
other non-PDF `IREPS_MA_INVALID_PDF`; nothing that is not a PDF is saved.
Batches run 3 downloads at a time with Queued / Downloading / Completed /
Failed per MA; after a session expiry the remaining MAs are not attempted
and can be retried with **Retry failed downloads**. Files keep the IREPS
name (see "File names" above); `MA_<PO-NO>_<MA-NO>.pdf` is used only when IREPS
gives none, because MA numbers repeat across POs. Files are grouped in a folder per MA date.

### MA error codes

| Code | When |
|---|---|
| `IREPS_MA_SEARCH_FAILED` / `IREPS_MA_RESULTS_INVALID` / `IREPS_MA_PARSE_FAILED` | as for CRN (section 13) |
| `IREPS_MA_NOT_FOUND` | no MA matched the date selection (the message says how many IREPS returned) |
| `IREPS_MA_LINK_NOT_FOUND` | the row has no "View/Download MA" link, or it points outside IREPS |
| `IREPS_MA_DOWNLOAD_FAILED` | network error, HTTP ≠ 2xx, or Chrome could not save the file |
| `IREPS_MA_INVALID_PDF` | IREPS returned something that is not a PDF (and not a login page) |
| `IREPS_SESSION_EXPIRED` | login / expired page at any step, including a PDF request |

---

## 15. Save to: this computer or the Recon Engine (S3)

One **Save to** switch at the top right of the main panel applies to the
Bill Status, CRN and R-NOTE downloads (remembered in `chrome.storage.local`):

| Choice | What happens to the export file |
|---|---|
| **Local** | `chrome.downloads` into `Downloads/DocLink/IREPS/` (Bill Status), `.../CRN/`, `.../RNOTE/` - unchanged behaviour |
| **Recon (S3)** (default: "ECM / S3" until Local is picked) | `POST {reconBaseUrl}/api/documents` (multipart `customer_id`, `doc_type`, `file`) on the Recon Engine (`recon-engine` repo, `backend/app/routes.py`) |

The Recon Engine stores the file in its managed storage - S3 when it runs
with `STORAGE_BACKEND=s3` - one directory per document type, content-addressed
(identical bytes are stored once):

```
s3://<S3_BRONZE_BUCKET>/<S3_PREFIX>bronze/<customer>/bill_status/<sha256>.xlsx
s3://<S3_BRONZE_BUCKET>/<S3_PREFIX>bronze/<customer>/rnote/<sha256>.xlsx
s3://<S3_BRONZE_BUCKET>/<S3_PREFIX>bronze/<customer>/crn/<sha256>.xlsx
```

and then parses it into its reconciliation data (bills / lineage), exactly
like a manual upload. The result panel shows the stored `s3://` path and the
load counts ("Loaded into Recon: 12 new, 3 updated, 40 unchanged"). A Recon
upload is always Excel (the Recon parsers read .xlsx only), so the CRN /
R-NOTE format choice is locked while Recon (S3) is selected.

**Sign-in.** The upload carries the Recon Engine's sign-in cookie, made on
DocLink's own *Sign in to Recon Engine* page (section 17). DocLink asks for it
before the run; if the session ends mid-run the card shows *Recon Engine
sign-in required* with a **Sign in to Recon** button.

**Settings** (`config.json`; reload DocLink after editing):

| Key | Default | Meaning |
|---|---|---|
| `reconBaseUrl` | none (unset: `RECON_NOT_CONFIGURED`) | Recon Engine API origin. Its origin must also be in `manifest.json` `host_permissions` - add the deployed Recon URL there |
| `reconCustomerId` | `default` | Recon customer key the files are filed under |
| `reconAppUrl` | `reconBaseUrl` | The Recon Engine web app (e.g. the Vite dev UI on `:5173`); no longer needed for sign-in |
| `okta` | see section 17 | Okta sign-in to the Recon Engine: `enabled`, `issuer`, `clientId`, `redirectPath` |

**Errors** (`utils/messages.js`):

| Code | Meaning |
|---|---|
| `RECON_NOT_CONFIGURED` | `reconBaseUrl` empty/invalid, or its origin missing from `host_permissions`; nothing sent |
| `RECON_AUTH_REQUIRED` | HTTP 401 - not signed in to the Recon Engine; nothing saved |
| `RECON_UNAVAILABLE` | network error or no answer within 2 minutes |
| `RECON_REJECTED` | any other non-2xx (e.g. unknown customer); the Recon Engine's reason is shown |
| `RECON_NOT_INGESTED` | HTTP 422 - the file **is stored** in S3 but could not be loaded; the parse error is shown |

Tests: `test/recon-tests.js` (fake fetch; part of `test/run-tests.html`).

## 16. Save to: ECM / S3 - IC, PO, MA and tender documents in the ECM

The same switch (shown as **ECM / S3**, stored value `recon`) files the
document PDFs in the ECM (Nuxeo) instead of Downloads, as the spec
"TSG India Doculink ECM specifications.xlsx" › "ECM - Download speci-v1" asks.
DocLink posts each one to the Recon Engine's ECM gateway with the same
settings, sign-in cookie and host permission as section 15:

`POST {reconBaseUrl}/api/ecm/documents`, multipart `kind`, `file`, `title`
(tender documents), `fields` (JSON) and the routing `ireps_account_id` +
`operating_unit` (`services/ecm-service.js`; gateway: recon-engine
`backend/ECM`, mounted at `/api/ecm`).

| Document | `kind` | `fields` | Title (`dc:title`) |
|---|---|---|---|
| Inspection Certificate | `inspectionCertificate` | `ic_number` (the IC PDF's file name, e.g. `3480517`), `customer_po_number`, `ic_date` | `3480517 - IC` |
| PO | `poCopy` | `customer_po_number` | `<PO no> - PO` |
| Modification Advice | `modificationAdvise` | `customer_po_number`, `modification_advise_number` | `<MA no> - MA` |
| NIT + attached documents | `nit` | `tender_number`, `tender_date` | **one document per tender**, `<tender no> - NIT`: the tender PDF is its main file, each attached document an attachment |
| Corrigendum | `extension` | same | `<tender no> - Extension - <corrigendum no>`; a document attached to it `<tender no> - Extension - <corrigendum no> - Attachment <n>` |
| Negotiation letter | `nbsp` | same | `<tender no> - NBSP - <letter id>` |
| Counter offer | `co` | same | `<tender no> - CO - <letter id>` |
| LOA (Advance Acceptance Letter) | `loi` | same, plus `loi_number`, `loi_date` | **one document per tender**, `<tender no> - LOA`: every letter in it, as `LOA_<tender no>_<letter id>.pdf` (a printed page, so DocLink names it) |
| Correspondence | `crp` | same | `<tender no> - CRP - <subject>` |
| Financial Tabulation | `tenderResult` (ECM "Tender Result") | same | **one document per tender**, `<tender no> - Result` |
| Commercial Tabulation | `vct` | same | `<tender no> - Commercial Tabulation` |

**Type labels.** DocLink sends only the type id (`InvoiceCertificateSchema:type`: `nit`,
`poCopy`, `loi`, `modificationAdvise`, `tenderResult`, `vct`, ...). The label the ECM shows
under "Document type" comes from the ECM's vocabulary `invoice_certificate_document_types`
and is changed there by the ECM admin, not in DocLink. Wanted labels (Wabtec, 05/11/2026):
`nit` NIT, `poCopy` PO, `loi` LOA, `modificationAdvise` MA, `tenderResult` Results,
`vct` Commercial Tabulation (today: "Tender NIT", "Advance Acceptance Letter",
"Tender Result", "View Commercial Tabulation"). Renaming a label leaves the ids and every
stored document as they are.

**One document per tender (NIT, LOA, Result).** As the Wabtec team asked on
29/10/2026 (example tender 38265117: `38265117 - NIT`, `- LOA`, `- Result`). These
are the *grouped* kinds of `services/ecm-catalog.js` (`group: true`). The first PDF
creates the document (its `file:content`). Every later PDF is appended to its
attachments (`files:files`) by Nuxeo's `Blob.AttachOnDocument`
(`POST /nuxeo/api/v1/upload/{batch}/0/execute/Blob.AttachOnDocument`), which adds one
file without re-sending the others. The document is found by type, folder, title and
tender number (`groupDocumentQuery`); a PDF already in it under the same file name is
not added again. A tender date the document lacks is filled in. In a full run the
attachments go to the ECM only after the tender PDF, so the tender PDF is the main
file. The download check does not look these up in the ECM (a shared title says
nothing about one PDF); the upload finds a PDF by its name. **Direct ECM only:** the
Recon gateway cannot add attachments, so with `ecmBackendAws: true` these PDFs are
saved locally (`ECM_REJECTED`) until the gateway learns it. Documents uploaded before
this change keep their old titles; an old `<tender no> - NIT` document becomes the
one new attachments go into.

**Only properties the ECM has.** A query or create naming a property the ECM's
`InvoiceCertificateSchema` lacks answers HTTP 400 "No such property". `tenderDate`,
`loiNumber` and `loiDate` were missing on 26/10/2026 and were there on 03/11/2026
(`GET /nuxeo/api/v1/config/schemas/InvoiceCertificateSchema`). Tender documents now
carry `tenderDate` (the IREPS closing date). Map any new property in
`services/ecm-catalog.js` `ECM_FIELDS` and list it in the kinds; the gateway's
`document_kinds.toml` must match.

**The fields the client asked for on 13/11/2026.** DocLink sends them since version 1.5.0, with
no setting to switch them.
- **LOA.** `loi_number` is the number IREPS prints on the letter, `<Dept> / <Tender No> / <LetterId>`
  (e.g. `DAHOD / 61265711C / 1503282`). DocLink builds it from the LOA list row:
  - the department part of "Dept/Rly. Unit" (`DAHOD / WESTERN RLY`);
  - the tender number;
  - the id in "Letter Date (LetterId)".

  `loi_date` is that row's Letter Date. DocLink sends both or neither: a row without a readable
  "Dept/Rly. Unit" sends neither. The `<T> - LOA` document keeps the values of the letter that
  created it, because later letters only fill in what it lacks.
- **Correspondence.** `tender_date` is the "Closing Date" next to the tender number on the Tender
  Related Correspondence page, which is the tender's closing date. The letter quotes it ("Ref:
  Tender No. 86256328 closing date 15/07/2025 11:00"); the letter's own deadline is "Last date for
  submission of reply".

**Where the tender date comes from.**

| Document | Source of the tender date |
|---|---|
| NIT and corrigendum | The tender search row's "Due Date/Time"; when the search gives none, the NIT message's "due on" date. |
| Financial and Commercial Tabulation | The Closed Tenders row's "Closing Date/Time". |
| Negotiation, Counter Offer and LOA | A tender search by tender number, once per tender in a run. |

Railways reuse tender numbers: 10263703 is both a N F RLY and an EAST CENTRAL RLY tender. When
the search shows a number more than once, DocLink takes:
- the row on the letter's own railway (from the list's "Dept/Rly. Unit");
- in automatic mode, the row due on the NIT message's date.

A hint that fits no row leaves the choice as before (the row with the most actions). This adds no
request.

The title is `<document number> - <code>`, the codes of the spec's row 4
(API: "Example Title - IC", "- PO", "- MA", "- NIT", ...; "- LOA" and "- Result"
as the Wabtec team asked) and the numbers of its row 8 (Title). It is also the ECM
document's `name`. A tender holds several corrigenda and letters, so those (except
the grouped LOA) add what tells them apart. IC, PO and MA titles come from the kind's template
(`services/ecm-catalog.js`, and the gateway's `document_kinds.toml`, kept in
step); tender titles are sent by DocLink (`tender/tender-ecm.js`).

* **Which folder.** The IREPS account is read from the home page's welcome
  line (`utils/ireps-account.js`, parsed in the offscreen document for the
  service worker and in the side panel for tenders). Account `833` is HOSUR
  and `60828` is ROHTAK; the gateway maps them to the unit's ECM folder. An
  account that cannot be verified is never guessed: the document is saved
  locally.
* **Nothing is lost.** When the ECM does not take a document (not signed in,
  not configured, refused, unavailable) it is saved locally as with Local, and
  the row says why (`ECM_*` codes in `utils/messages.js`).
* **Duplicates.** The gateway stores a document once; a re-run answers
  "Already in ECM".
* **Stays local:** My Offer (no ECM type), the tender `download_manifest.json`
  (it records each document's ECM uid), and the original `.html` kept beside a
  print-ready letter's PDF rendering.

Tests: `test/ecm-tests.js` (browser suite), the ECM cases in
`test/ic-tests.js` / `ma-tests.js` / `po-tests.js`, and the "ECM:" tests in
`tender/tests/run-tests.mjs`.

### Direct mode (local testing): DocLink calls the ECM itself

`config.json` `"ecmBackendAws"` picks the path for these ECM documents:

* `true`: the Recon Engine's ECM gateway, as described above.
* `false` (the default): DocLink calls the ECM (Nuxeo) REST API directly
  (`services/ecm-direct.js`), following `ECM_API_DOC`. It gets a client-credentials token,
  checks for an existing copy with an NXQL query, opens a batch upload, uploads the file
  and creates an `InvoiceCertificate` in the unit's folder.

Folders, metadata, dedup rule, answer and `ECM_*` error codes are the same as the
gateway's, so the panel, the local fallback and the manifests work unchanged.
The folders and metadata come from `services/ecm-catalog.js`, a copy of recon-engine
`backend/ECM/ecm_client/config/`.

Bill Status, CRN and R-NOTE still go to S3 through the Recon Engine. Only those runs ask
for the Recon sign-in in direct mode.

```json
"ecmBackendAws": false,
"ecm": { "env": "TEST", "domain": "http://wctsrvecmtstsn1.wabtec.com:8080",
         "clientId": "abc", "clientSecret": "abc", "timeoutMs": 120000 }
```

* **Credentials.** The `abc` values in `config.json` are placeholders. Put the real
  `clientId` / `clientSecret` in **`config.local.json`**, which uses the same shape:
  - top-level keys replace those in `config.json`, and `ecm` is merged key by key;
  - it is gitignored and never packaged by `scripts/build.mjs`.

  Reload DocLink after editing either file. The secret and the token are never logged or
  stored. A built extension has no `config.local.json`, so in direct mode it reports
  "ECM not configured" and saves locally. The build stops if `config.json` itself holds
  a real-looking secret (8 characters or more; section 9).
* **`env`** picks the folders:

  | env | Site | `ecm:ancestorId` | Folders |
  |---|---|---|---|
  | `TEST` | Hosur (833) | `ad5090e5-648d-4f75-8c14-7052e8ac3b72` | Inputs `d440070d-…`, Tenders `aa28acbe-…` |
  | `TEST` | Rohtak (60828) | `34a61f51-10fe-44ce-a669-2ea14dc86ff4` | Inputs `93a37d6e-…`, Tenders `a6594520-…` |
  | `PROD` | Hosur | `7dfe3fc0-3157-489d-826a-9435e65631fc` | Inputs and Tenders: the PROD creation folder `99e2faf3-…` |
  | `PROD` | Rohtak | `f2a5bf87-877b-4e4c-b4fc-7301cabfd236` | Inputs and Tenders: the PROD creation folder `99e2faf3-…` |

  IC, PO and MA go to Inputs. NIT, LOI, corrigendum, negotiation, counter offer,
  correspondence and the tabulations go to Tenders. On PROD, until the ECM team supplies
  each site's folders, every document of both sites goes to the one creation folder the
  PROD client can write to (`PROD_CREATION_FOLDER` in `services/ecm-catalog.js`). Because
  that folder is shared, a tender both sites download gets one NIT / LOA / Result document,
  not one per site.
* **Switching to PROD.** Copy `config.local.prod.example.json` to `config.local.json` and
  fill in the PROD `domain`, `clientId` and `clientSecret` there. Set all four `ecm` keys:
  any key you leave out comes from `config.json` (the TEST ECM). The PROD origin must also
  be in `manifest.json` `host_permissions`. DocLink never reads the example file itself.
* **Folder check.** A supplied folder uid is opened once per session (`GET /id/{uid}`).
  If the ECM cannot open it, the upload is refused with the folder's name, path and uid,
  and the document is saved locally. On 26/10/2026 both TEST Tenders folders failed this
  check (HTTP 404). For Hosur `aa28acbe-…`, NXQL answers "Unknown document type:
  InvoiceCertificateTenderFolder". The Rohtak `a6594520-…` does not exist. The Inputs
  folders open at their catalog paths.
* **Host permission.** The `ecm.domain` origin must be in `manifest.json`
  `host_permissions`. `http://wctsrvecmtstsn1.wabtec.com:8080/*` is already there. The
  server is on the Wabtec network. The address is plain `http://`, so DocLink logs a
  warning once (it does not block).
* **Token request.** DocLink gets its token as it always has: the client id and secret
  are in the token request's URL, as ECM_API_DOC shows. Sending them in the request body
  instead, so that URL logs never hold the secret, is a code change for when the ECM team
  confirms the token endpoint accepts it (review H10).
* **One upload at a time, everywhere.** Uploads already ran one at a time within each part
  of DocLink. A Web Lock (`doclink.ecm.upload`) now also makes the service worker and every
  side panel take turns.
* **Duplicate tender documents.** After DocLink creates a tender's grouped document (NIT,
  LOA, Result), it repeats the same read-only lookup. If an older copy exists (another
  user or PC created one at the same time), it logs a warning. Nothing is merged or
  trashed.
* **Finding what was stored.** Use the spreadsheet's query, with straight quotes:
  `SELECT * FROM Document WHERE InvoiceCertificateSchema:type = 'poCopy' AND ecm:ancestorId = '<site id>'`.
  `buildEcmQuery()` in `services/ecm-direct.js` builds it (optionally filtered by
  `customer_po_number`, `ic_number`, `tender_number`, and so on) and `searchEcm()` runs it.

Tests: `test/ecm-direct-tests.js` (browser suite) and the "ECM direct:" test in
`tender/tests/run-tests.mjs`.

## 17. Two logins: IREPS and the Recon Engine

DocLink works with two separate logins:

| | Login 1: IREPS | Login 2: Recon Engine |
|---|---|---|
| Who | The vendor's IREPS account | Your joulestowatts Recon Engine account (password) or Okta |
| How | In the IREPS tab, with the e-sign / security key, as always | DocLink's **Sign in to Recon Engine** page |
| Needed for | Everything (reading IREPS) | Every download while the download log is on (§18, the default); only **Save to: ECM / S3** when it is off |
| Header | `IREPS` pill | `RECON` pill (always shown while the download log is on, else while ECM / S3 is selected; click to sign out) |
| DocLink handles | Nothing - it only checks the session | The typed password, sent once to the Recon Engine |

**When the page appears.** With the download log on (§18), starting any
download (Bill Status, CRN, R-NOTE, MA, PO, IC, the batches, tender, pending
correspondence), Local or ECM / S3, asks the Recon Engine who is signed in
(`GET /api/auth/me`). When nobody is, the sign-in page covers the panel (a
running job is untouched); **Cancel** leaves the run unstarted
(`DOWNLOAD_LOG_SIGN_IN_REQUIRED`). With the log off (`"downloadLog": {
"enabled": false }`) only ECM / S3 runs ask, and **Use Local instead** switches
Save to back to Local and the run saves locally.

**Password.** Any Recon Engine user (`scripts/create_user.py` in the
recon-engine repo) signs in with `POST /api/auth/login`; wrong password,
no role and the 5-minute lockout after 8 failures each have their own message.

**Okta.** **Sign in with Okta** is offered when `config.json` `okta` is set
and the Recon backend has Okta configured (`GET /api/auth/providers`):

1. DocLink asks the backend for the authorize URL
   (`GET /api/auth/okta/extension/start?redirect_uri=https://<extension id>.chromiumapp.org/okta`);
   the backend keeps state, nonce and PKCE verifier in the session cookie.
2. It opens it only if it is the Okta app `config.json` names (`issuer`,
   `clientId`), with `chrome.identity.launchWebAuthFlow`.
3. Okta returns `?code=&state=` to the extension redirect; DocLink hands them
   to `GET /api/auth/okta/extension/finish`, where the backend exchanges the
   code with its client secret and opens the same session as a password
   sign-in.

```json
"okta": {
  "enabled": true,
  "issuer": "https://wabtec.oktapreview.com/oauth2/default",
  "clientId": "0oa2uq0thn3v0mHWG0h8",
  "redirectPath": "okta"
}
```

**Okta setup (once).** Add
`https://cglncbgakabfoenpkbaoigpclmgkklcl.chromiumapp.org/okta` as a
*Sign-in redirect URI* of the Recon Engine Okta app. No sign-out redirect is
needed: Sign out ends only the Recon session. The extension id is fixed by the
public `"key"` in `manifest.json`, so every copy (unpacked from any folder, or
the `dist/` build) has the same id and this one redirect. The sign-in page
shows the exact value under *Okta setup* (with Copy). The matching private key
(`doclink-key.pem`) is kept **outside** the extension folder and is never
shared or packaged: Chrome warns about a `.pem` inside a loaded extension, and
it is needed only to publish to the Chrome Web Store. Removing or changing
`"key"` changes the id and the redirect. Until the
redirect is registered Okta refuses the request and DocLink says so
(`OKTA_REDIRECT_NOT_REGISTERED`); password sign-in keeps working. The client
secret stays in the Recon backend (`OKTA_CLIENT_SECRET`), never here.

**Errors** (`utils/messages.js`): `RECON_SIGNIN_INVALID`,
`RECON_SIGNIN_NO_ACCESS`, `RECON_SIGNIN_LOCKED`, `RECON_SIGNIN_UNAVAILABLE`,
`OKTA_NOT_CONFIGURED`, `OKTA_CANCELLED`, `OKTA_REDIRECT_NOT_REGISTERED`,
`OKTA_FAILED`, `OKTA_NO_ACCESS`, `OKTA_INACTIVE`.

Code: `services/recon-auth.js` (requests), `popup/popup-recon-auth.js` (page
and pill). Tests: `test/recon-auth-tests.js` (browser suite).


---

## 18. Download log: who downloaded what, and "already downloaded"

Every file DocLink saves is recorded in the Recon Engine for the **signed-in
Recon user** (login 2, §17): document type, file name, destination (Local /
ECM / S3), date and time (server time; the API also returns the IREPS-style
IST date and time). Before a run DocLink asks which of the documents it is
about to fetch **this user already downloaded to the same destination**, and,
under **Save to: ECM / S3**, which are **already in the ECM folder** they would
go to. When there are any, a page covers the panel:

> **Already downloaded** - 2 files were already downloaded by you to your
> Downloads folder. 1 file is already in the ECM folder they would go to.
> Tick the ones to download again; the others are skipped.

Each row says when (`Downloaded on 2026-10-22 at 10:05 as PO_x.pdf`) or where
(`In ECM: /FT/workspaces/Sites/HSR/Invoice Certificate - TS/Inputs/007012`).
Nothing is ticked by default; **Skip them, download only new files** or
**Download N files again**. Unanswered for 4 minutes = skip. Skipped documents
are not fetched from IREPS at all and show an **Already downloaded** /
**Already in ECM** chip (hover for when / where); the summaries count them.

**Download again puts the new PDF in the same ECM document** (MA, PO, IC and
their batches, direct mode `ecmBackendAws: false` only; the page then says so).
For a ticked file that is already in the ECM, no new document is made: the
document the check found (same kind, folder and numbers, whatever its file
name) is updated in place (`PUT /id/{uid}`), its title and metadata untouched.

- The new PDF becomes the main file, under the main file's current name (the
  one the ECM gave it, e.g. `LC261044100166_MODIFICATIONADVISE.pdf`).
- **Old PDF intact:** it stays in the document as an attachment named
  `<name>_old.pdf` (`_old_2`, ... when taken). Attachments already there are
  kept (they are read and sent again: the ECM replaces the list as a whole).
- **Old PDF damaged** (the ECM cannot serve it in full): it is dropped. "Damaged"
  needs proof: the last-byte read fails AND a read of the whole file comes back
  short or missing (404).
- A **temporary ECM error** on those reads (5xx, 408, 429, network, timeout) is
  retried up to 3 times. If it does not clear, nothing is changed and the PDF is
  saved locally (`ECM_UNAVAILABLE`). A healthy old PDF is never dropped because
  of a passing error. If the ECM damages the new PDF, it is saved locally too
  (`ECM_FILE_DAMAGED`), the old one still being in the document as `_old`.
- When the check found several copies, the first gets the new PDF. Any other
  copy that is proven damaged goes to the **ECM trash** (Nuxeo `Document.Trash`,
  restorable); healthy ones are left alone.

The row reads `Saved to ECM (Hosur): new PDF in the existing document; the old
one is kept in it as <name>_old.pdf` (or `(the damaged one was removed)`).
Through the Recon gateway, and for tender documents, download again uploads as
before and replaces nothing.

**Every ECM upload reads back.** The ECM re-saves IC / PO / MA PDFs while it
creates them, and uploads created at the same moment came out damaged (the
record keeps the uploaded length, the stored file is shorter, every download of
it breaks off). So uploads go one at a time, and after each one DocLink reads
the last byte of the stored file; a copy the ECM cannot serve in full is
`ECM_FILE_DAMAGED`: DocLink's own new copy is moved to the trash and the file
is saved locally, and an earlier damaged copy is not reported as "already in
the ECM".

| Flow | Checked first | Logged |
|---|---|---|
| MA, PO, IC (single) | yes | yes |
| PO by date, IC from notifications | yes (a retry is not re-checked) | yes |
| Tender documents (all categories, jobs and single tender) | yes, one question per run: *Same answer for the rest of this run* | yes |
| Correspondence | its own "already saved / Download again" (unchanged) | yes |
| Bill Status, CRN, R-NOTE | yes: the **same rows** (a SHA-256 of the format and the rows IREPS returned) already downloaded to the same destination -> "not saved again" unless you choose to; new or changed rows make a new file | yes (`s3` under ECM / S3) |

**Which document is "the same".** A key built from the document's numbers,
never the file name (`services/download-log.js` `downloadKey`): `po:<PO>`,
`ma:<PO>|<MA>`, `ic:<PO>|<PO Sr.>|<Call Id>`, `tender:<category>|<tender>|<id>`,
and for an export `export:<type>:<fingerprint of its rows>` (its file name and
bytes carry the time of the run, so they never repeat).
"Already downloaded" is per user **and** per destination: a PO saved locally
last week is still new when you pick ECM. The ECM check matches the kind's
numbers in the upload folder (`ecm:parentId`), dates aside, and the title for
tender documents - not file names, because other tools store the same
document under other names. Through the Recon gateway
(`POST /api/ecm/documents/exists`) or, in direct mode, the same NXQL from
DocLink (one `... IN (...)` query per kind).

**Never blocking.** If the log or the ECM cannot be checked, the run downloads
everything and says so ("Download log unavailable"). Records are queued in
`chrome.storage.local` (`doclink.downloadLog.queue.sw` / `.panel`) and posted
in batches of up to 500; a failed post (backend down, sign-in expired) keeps
them for the next one. Tender jobs fall back to their local ledger when the
log does not answer.

**Recon Engine API** (`recon-engine` `backend/app/downloads.py`, table
`doclink_downloads`, migration `a7d3c9e15b20`; any signed-in role, viewers too):

| Endpoint | Body / query | Answer |
|---|---|---|
| `POST /api/doclink/downloads` | `{records:[{doc_type, doc_key, filename, destination, ireps_account_id?, ecm?}]}` (≤ 500) | `201 {logged}` |
| `POST /api/doclink/downloads/check` | `{destination, keys:[...]}` (≤ 1000) | `{downloaded: {key: {count, filename, downloaded_at, date, time}}}` (the caller's own) |
| `GET /api/doclink/downloads` | `?from=&to=` (IST days), `doc_type`, `destination`, `limit`, `offset`; an admin may add `user_id=` or `all=true` | rows with user email / name, date and time in IST |

**My Downloads.** The download icon at the top right of the panel (next to the
IREPS / RECON pills; click again to go back) shows what the log holds for the
signed-in user as a table, newest first: **Date** (dd/mm/yyyy and time, IST),
**Type**, **File** (with the IREPS account) and **Location** (**Local**,
**ECM · Hosur** / **ECM · Rohtak** with its folder - hover for the full path -
and "already there" when the ECM already had it, or **S3**). Filters: date range
(last 7 days by default), **Location** (All, Local, ECM - all sites, ECM -
Hosur, ECM - Rohtak, S3) and **Document type**; 50 rows at a time with **Load
more**. An admin also gets **All users**, which adds each row's user under the
file name. It reads `GET /api/doclink/downloads` (`destination`, `site`,
`doc_type`, `from`, `to`; `popup/popup-downloads.js`).

**Switch.** `config.json` `"downloadLog": { "enabled": true }` (default).
`false` turns off the log, the check and the required sign-in; DocLink then
behaves as before. `config.local.json` may override it.

Code: `services/download-log.js` (keys, check, queue, pre-flight),
`popup/popup-redownload.js` (the page), `services/ecm-service.js` `findInEcm`
and `services/ecm-direct.js` `findInFolder` (ECM check), the `preflight` /
`onSaved` hooks of `services/search-po/document-downloader.js`.
Tests: `test/download-log-tests.js` (browser suite), the "Download log" tests
of `tender/tests/run-tests.mjs`, and `backend/tests/test_doclink_downloads.py`
plus the `find_in_folder` tests in the recon-engine repo.

---

## 19. Financial and Commercial Tabulation

"ECM - Download speci-v1" columns L and M (ECM types `vft` / `vct`). IREPS
shows both on a tender's row in **Closed Tenders** (Vendor inbox, Tenders ›
Closed Tenders) once the bids are opened, next to My Offer
(`01_api_data/finncial and commercial documentation response.har`, and the
29 Oct capture `financial and commercial documentation response_29oct.har`).
The tabulation opens in a popup window, so neither capture holds its response:

| Link | Request (POST, as `postRequestNewWindow` sends it) |
|---|---|
| View Financial Tabulation | `/epsn/tbo/commTboPdfAction.do?tenderOID=<oid>&pdfType=financialTabulation&accountID=<acct>` |
| View Commercial Tabulation | `/epsn/tbo/commTboPdfAction.do?pdfType=commercialTabulation&tenderOID=<oid>&accountID=<acct>` |

The list itself is `POST /epsn/vendorInboxLink.do` with `menuLink=Tenders`,
`status` = `listType` = `MyBidsClosed`, `tenderNo`, `startDate` / `endDate`
(the **Closing Date**, dd/mm/yyyy) and `pageNo`; each row gives Dept/Rly. Unit,
Tender No. (Bid Id), Tender Title and Closing Date/Time
(`parseClosedTenders`, `scanClosedTenders` in `tender/tender-workflows.js`).

* **Panel.** "Download Tender Documents" › **Financial Tabulation** /
  **Commercial Tabulation**: every tender that closed between From and To (the
  optional Tender Number narrows it) and shows the link is downloaded to
  `Downloads/DocLink/<unit>/Tender_<no>/Tabulation/`; a closed tender without
  it reads "not available yet" (re-run the range later). A range longer than
  90 days is read in 90-day windows (`downloadTabulationsByDate`,
  `tender/tender-jobs.js`; `runTabulations`, `tender/tender-auto.js`).
* **Single tender.** `downloadTenderDocuments` has the two categories
  `financialTabulation` / `commercialTabulation`: from the tender's search row,
  else from its Closed Tenders row (one scan, closing date ± 1 day).
* **Checks.** The link's `accountID` must be the active IREPS account; what was
  downloaded before is skipped (download log types `financial_tabulation` /
  `commercial_tabulation`, else the ledger). The tabulation must be a PDF. A
  PDF behind a viewer page (iframe / embed, a self-submitting form, a
  `window.open` / `location` target) is followed. A web page that leads to no
  PDF fails with the page's title and first words, and is never saved as the
  tabulation. DocLink waits up to 3 minutes for IREPS to build the PDF. Every
  answer is logged under `Tabulation` (status, content type, file name, size,
  kind, the files tried) - `doclinkLog.download()` in the side panel console.
* **ECM.** Under Save to: ECM / S3 they go to the unit's Tenders folder with
  `tenderNumber` and `tenderDate` (section 16): the Financial Tabulation as the
  tender's `<tender no> - Result` document (type `tenderResult`, "Tender Result";
  direct ECM only), the Commercial one as `vct`. `vft` stays in the catalog, in
  step with the gateway's `document_kinds.toml`, but DocLink no longer uses it.
* **Excluded.** `isExcludedUrl` (`tender/tender-core.js`) refuses any other
  `pdfType` (e.g. a Techno-Commercial Tabulation) and any "techno" file name;
  it reads `pdfType` from a POST body too. Inside an allowed Financial /
  Commercial response, a file named only "Tabulation_..." may be fetched, but
  a "techno" name or another `commTboPdfAction.do` link never is. `TECH-TAB`
  was once taken for the Techno-Commercial Tabulation; it is IREPS's name for
  the Commercial Tabulation itself (see below).
* **What IREPS answers** (captured 03 Nov 2026). `commTboPdfAction.do` returns
  a small page that opens the PDF from `<body onload="openwindow('...')">`:
  `/ireps/supply/pdfdocs//<MMYYYY>/<tenderOID>/FIN-TAB-<no>-<oid>.pdf` for the
  Financial Tabulation and `.../TECH-TAB-<no>-<oid>.pdf` for the Commercial
  one. IREPS names the Commercial Tabulation's own file `TECH-TAB`, so that one
  file (a `TECH-TAB-*.pdf` under `/ireps/supply/pdfdocs/`, no query, no
  "techno") is allowed, and only inside a `commercialTabulation` response.
  Anywhere else `TECH-TAB` stays blocked.

---

## 20. Upload Bill to IREPS (bill upload)

Bills an ECM invoice against an IREPS receipt, up to the point where IREPS needs
the user's digital signature. The study behind it - every call, field, source
and open question - is `upload.md`; this section is how DocLink implements it.
Started by hand from the side panel (**Bill** on the main view's *Upload* card).

```
1 Receipt    PO number -> R-NOTE + CRN search (searchPO.do, read-only)
             -> receipts with a "Bill Claim" link (rly, poKey); others greyed out with the reason
2 Invoice    ECM RetrieveInvoiceData {customerPO, customerPOSrNo, invoiceQuantity}
             (exactly one match, not "Sent to Doculink") - or from a JSON file the user picks
             (same columns, same match) - or typed by hand
             -> checked before any IREPS call: number, date, amount, HSN code of 4 to 8 digits
3 Prepare    read-only IREPS calls in the IREPS tab: fetchPODetails.do (bill page), populatePayAuthList,
             populatePOSrList, getAjaxData (GSTIN), populateROList, populateRODetails
             -> every header value with its source + checks; the user may correct supplier GSTIN,
                state / place of supply and bill description (re-checked)
4 Create     only with no error, warnings read and the values confirmed:
             saveBillHeader.do (creates the DRAFT bill - the header cannot be edited afterwards)
             -> fetchPOItemDetails / populateROList / populateRODetails -> amounts computed like the
                bill page -> item checks -> saveBillDetails.do
5 Documents  the invoice's ECM documents (per-type NXQL by invoice no. / PO no., newest per type),
             checked (PDF, < 8 MB) and saved to Downloads/DocLink/IREPS/BillUpload/<invoice>/,
             each with the description to type in IREPS
5b Upload    once the item is saved (IREPS needs the dispatch no.), one PDF < 8 MB at a time with
             its description (min. 5 characters): IREPS signer on the user's PC (wss://127.0.0.1:2175;
             the user selects the DSC and enters the PIN) -> the signature must be from the DSC
             registered in IREPS (certThumbprint) -> /cgi-bin/save.php -> uploadBillDocuments.do,
             all from the IREPS tab -> the documents now on the bill
Then in IREPS (manual): open the draft bill, attach any document not uploaded from DocLink
(each signed in the IREPS signer), Generate Preview, Sign & Submit with DSC + PIN.
```

| File | Role |
|---|---|
| `services/bill-upload/bill-upload-api.js` | The `/epsn/ct/*` calls: request bodies in the captured field order (`orderedBody` refuses a missing or extra field), the bill page's AJAX headers, parsers for the `^^` / `@#$%` answers; anything not starting with `success` is IREPS refusing, its text kept as the reason |
| `services/bill-upload/bill-form.js` | Reads the bill page (regex, no DOM): the `saveBillHeader()` script literals (`nitOid`, `poKey`, `unit`, ...), company, prefilled bank / IFSC, the supplier GSTIN / paying railway / railway GSTIN / state options, PO payment terms |
| `services/bill-upload/bill-rules.js` | Pure rules: `buildHeader`, `buildItem`, `computeAmounts`, GST split (IGST vs CGST + SGST / UTGST from the header states), state codes, the supplier-GSTIN-by-division and state-of-supply derivations, every check |
| `services/bill-upload/invoice-file.js` | The JSON-file invoice source: `parseInvoiceFile` (a list, `{ "invoices": [...] }` or one invoice, in ECM's column names; at most 1 MB / 500 invoices), `invoiceFromFile` (the receipt's invoice by PO + PO Sr + quantity, numbers compared by value). The file is picked in the panel at run time, never bundled, so it works in the built extension. Sample: `test/mock/sample_upload.json` |
| `services/bill-upload/ecm-invoice.js` | `retrieveInvoice` (answer read defensively - its format is not documented yet), `manualInvoice`, the bill document types with their IREPS descriptions, document search and fetch |
| `services/bill-upload/bill-upload-service.js` | The steps above (`findBillableReceipts`, `prepareBill`, `reviewBill`, `createDraftBill`, `saveItem`, `collectBillDocuments`) |
| `services/bill-upload/bill-upload-store.js` | Per receipt, what DocLink already wrote (bill reg no., dispatch no.; identifiers only) in `chrome.storage.local`: a receipt is never billed twice, also after a restart |
| `services/bill-upload/tab-transport.js` | A `fetch` that runs in the panel's IREPS tab (`chrome.scripting`) for the bill calls; `tabSignPdf` / `tabSaveFile` for step 5b |
| `services/bill-upload/bill-document-upload.js` | Step 5b (`uploadBillDocument`): the signer request and its frames (as IREPS' CRISPKI.js sends them), the signer's answer, the thumbprint check, `save.php` and `uploadBillDocuments.do` |
| `background/bill-tab-request.js` | Injected into the IREPS tab (isolated world, versioned): sends the bill calls from the portal's own origin, talks to the IREPS signer, stores the signed PDF with `save.php` |
| `background/bill-upload-job.js` | Service-worker job: `BILL_UPLOAD_*` messages, one step at a time, state in `chrome.storage.session`, `BILL_UPLOAD_UPDATE` to the panel |
| `popup/popup-bill-upload.js` | The view |

Safety rules: Prepare never writes. The invoice is checked before anything is
sent to IREPS, whatever its source (ECM, JSON file, typed): invoice number, date,
amount, and an HSN code of 4 to 8 digits. A bad one (an HSN such as "12") stops
Prepare with `BILL_INVOICE_INVALID`, before a draft bill exists. Create needs the
confirmation tick, refuses while any check is an error, and needs the warnings
ticked as read. A failure after the header was saved keeps the draft bill's
number on screen (item can be retried, or finished / deleted in IREPS). A receipt
with a DocLink bill, or one IREPS already shows a bill for, cannot be billed
again. **Start fresh** (a new bill for a receipt DocLink already billed) forgets
only DocLink's record: the old draft's bill number stays on screen with where to
find it (the PO's *Bills for Pay* tab), as it is still in IREPS, and the new
bill's last steps remind the user to delete it. *Finish in IREPS* is built from
the documents' real states: documents already on the bill are not asked for
again, the files DocLink saved are named, and a needed document DocLink has no
file for is listed with the description to type. The IREPS-tab script is
injected once per tab, and again only when the page was reloaded.

What DocLink derives because the ECM does not carry it yet (upload.md section 8,
to be confirmed by the business): supplier GSTIN from ECM `division`
(`WABHSR` -> 33AAGCS8525B1ZL, `WABRTK` -> 06AAGCS8525B1ZI), state of supply from
ECM `gstinRecipient` (else the consignee address), place of supply from
`supplyPlace`. All three are shown with their source and can be corrected.

Not supported yet (stopped by a check): advance / part payment, PVC, POs with
discount / packing / freight / other charges, several paying authorities,
several receipts per PO Sr without a match, multi-invoice bills. Not verified on
the live portal: the ECM `RetrieveInvoiceData` answer (no response captured) and
re-opening a DocLink-created draft in IREPS to attach the documents (IREPS
offers "View / Sign & Submit Draft Supplier Bill" from the R-NOTE / CRN row).
The mock portal serves the flow up to the saved item, including the ECM calls, plus a test hub
with the bill screens at http://localhost:8765/mock/bill/ (TESTING.md C9);
`node test/mock/bill-flow-check.mjs` runs the bill code against every test receipt. The mock
does not serve step 5b (`save.php`, `uploadBillDocuments.do`), and signing needs the real
IREPS signer.

---

## 21. Correspondence Downloads (`tender/tender-pending.js`, `tender/pending-ui.js`)

Main screen -> **Correspondence Downloads** -> **Download All Correspondence**.
No tender / correspondence / letter ids are typed in; all are read from the live responses.

Request sequence (all in the signed-in browser session, `credentials: include`):

1. `POST /epsn/corres/vendorRelatedCorrespondence.do` (empty body, as the portal menu link). Verified against the HAR.
2. Parse only the table under the heading **Correspondence - Pending** (found by heading, not position; Lapsed / Replied tables are never read). Rows whose own Status is not `Pending` are listed as *needs review*, not downloaded.
3. For each row: `POST /epsn/corres/vendorCorrespondencePendingReply.do` with form `nitOid=<from the row>`. Verified against the HAR.
4. Parse only the table under **Pending Replies** (Lapsed / Previous Replies ignored); every row's `viewPublishedLtr('<nitOid>','<corresId>','<letterId>')` gives the ids.
5. For each letter: the route is read from the page's own `viewPublishedLtr` script (fallback: `POST /epsn/corres/rly/viewpubIndltr.do`, form `nitOid`, **`letterID`**, `corresId`). The response is handled as a direct PDF, an embedded PDF viewer, or an HTML letter (rendered to a text PDF by the existing `buildPdf` utility; the original page is saved next to it).
6. Attachments: links in the letter response that point at document files or download/attachment actions are downloaded and recorded separately.

`vendorCorresSubmitReply.do` and anything that looks like a write action is refused in `pcFetch()` (`assertReadOnly`).

Output: `Downloads/DocLink/<verified unit>/Correspondence/Pending/<TenderNo>/Correspondence_<LetterNo>_<dd-mm-yyyy>_<Subject>.pdf` (a letter IREPS serves as a PDF keeps its IREPS name), attachments under their IREPS name (`<name>_<LetterNo>` when another file of the tender's folder has it), and `Downloads/DocLink/<unit>/Correspondence/Pending/download_manifest.json`.
Under **Save to: ECM / S3** each letter and attachment goes to the unit's ECM Tenders folder instead, as `crp` with the tender number, titled `<tender no> - CRP - <letter no> - <subject>` (attachments: `<tender no> - CRP - <letter no> - Attachment - <file name>`), with the same Recon sign-in and the same local fallback as the tender documents (section 16). Each letter row shows where it went. When Chrome cannot print a letter, its original `.html` page stays in Downloads.
Dedupe key: `accountId|nitOid|corresId|letterId` (stored in `chrome.storage.local`, no secrets). **Retry failed** and a repeated run skip letters already saved; tick "Download again" to force.
Requests are sequential. A GET that cannot reach IREPS (a network failure) is retried after 1 s and 3 s; a POST is never retried, so nothing is ever sent twice. A session expiry stops the job and marks the rest `SESSION_EXPIRED`. A list page DocLink does not recognise (no "Pending Replies" table, an HTTP error) is an error, never "no letters".

Unverified against the live portal: the exact response of `viewpubIndltr.do` (it is not in the supplied HAR) and the markup of its attachment links.

---

## 22. Batch downloads (PO by date, IC by date, IC from notifications)

All three live in the side panel under **Download PO / IC → "Download POs / ICs by date, or ICs from notifications"**.
They are download-only (no inspection call is submitted, approved, withdrawn or revalidated).
The **Save to** switch applies to all of them, as to a single PO / IC download: under **ECM / S3**
each PO is filed as `poCopy` (`customer_po_number`) and each IC as `inspectionCertificate`
(`ic_number` from the PDF name, `customer_po_number`, `ic_date`), with the same Recon sign-in
and the same local fallback when the ECM does not take a document (section 16). A retry uses
the switch's current choice. The IC manifest records each document's ECM outcome.

### Download POs by PO Date
`POST /epsn/searchPO.do searchParam=showPage` (token, session check) →
`POST /epsn/searchPO.do` with `searchCriteria=PO`, `searchRange=2`, `dateFrom`/`dateTo` as `DD/MM/YYYY`,
`rly=-1`, `recordsPerPage=20` and the token just read → every result page via the portal's own
`postRequest('/epsn/searchPO.do?…&pageNo=N…')` links. A selection longer than IREPS' 180-day limit is split into
consecutive windows searched one after another. Rows are re-checked against the selected dates, de-duplicated on
PO No. + unit + link, and each row's own "Click to View/Download PO" href is fetched, verified as `%PDF`, and saved as
`Downloads/DocLink/IREPS/PO/<PO date>/<IREPS file name>` (`PO_<PO>_<date>.pdf`, unit added only when two documents
would collide, when IREPS gives no name).
Rows without a link are listed as skipped with the reason.

### Download ICs by IC Date
Every Inspection Certificate whose **IC Date** is in From-To, for every PO.
`POST /epsn/tpi/vendorInspectionCallList.do callType=I&status=I` (token, session check, the portal's date defaults) →
the search with `poNo` and `poSr` empty, `dateFromIC`/`dateToIC` = the selected dates, `statusSelected=Completed / IC Issued`
and the Call Date fields (`dateFrom`/`dateTo`) left at the portal's defaults - `dateFrom` is only pulled back when the IC
From date is earlier, since a call precedes its IC → every `navigate(N)` page (50 calls a page), each with the token of
the page before. Rows are re-checked here: IC-issued status, IC Date in the range, de-duplicated on the IC PDF href.
Should IREPS ignore the IC dates, the newest-first list stops being read after two whole pages before From (and at
most 200 pages are read, with a warning). Each row's "View/ Download IC PDF" href is saved as
`Downloads/DocLink/IREPS/IC/<PO>/<IREPS file name>` (`IC_<PO>_<SR>_<CALLID>.pdf` when IREPS gives none), with the same download-log key and ECM fields as the other
IC downloads, so an IC already downloaded by any of them is recognised.

### Download ICs from Notifications
Only the IC of each notified PO **and PO serial** (one per "IC issued" notice); for every IC of a period use
Download ICs by IC Date.
`POST /epsn/vndr/activity/ajax.do ajaxMode=getMyActivitesData` → notifications with subject *Inspection* and message
"IC issued for PONo : … , POSrNo : …" (everything else ignored; identifiers kept verbatim) → for each distinct
PO + serial: `POST /epsn/tpi/vendorInspectionCallList.do callType=I&status=I` (fresh token), then the search with `poNo`,
`poSr`, `statusSelected=Completed / IC Issued`, every `navigate(N)` page → rows with the exact PO number, exact serial and an
IC-issued status → each row's "View/ Download IC PDF" href → `Downloads/DocLink/IREPS/IC/<PO>/<IREPS file name>` (`IC_<PO>_<SR>_<CALLID>.pdf` when IREPS gives none).
`REF_ID` is compared with the row's Call Id and reported, not trusted as the certificate number. A manifest
(`IC_notifications_manifest_<time>.json`: ids, outcome, reason - never cookies or tokens) is saved beside the ICs.
Searches run one at a time (the Struts token belongs to the session); downloads run 3 at a time with up to 2 retries for
network / timeout / HTTP 5xx only. An expired session is never retried.

### What is not verified against the live portal
* The empty-result page of a **date-range** PO search (handled via "no record found" markers and zero-row tables).
* That `searchRange=2` filters by *PO date* (rows are re-checked client-side regardless).
* `recordsPerPage` above 20 for PO searches (20 and the page links are used).
* The inspection-call date window: the portal's own default is used first; if nothing matches, one wider retry
  (`dateFrom`/`dateFromIC` = 01/01/2015) is made. Whether IREPS accepts that early a date is unconfirmed.
* Notifications beyond what `getMyActivitesData` returns (no other notification endpoint is called).
* The IC Date search with PO No. empty. The captured list page (no PO, portal defaults) lists every PO's ICs and has
  the IC Date From / To fields, but a submitted search with only the IC dates set is not in a capture.

---

## 23. Scheduled downloads (Phase 1: Bill Status, CRN, R-NOTE, MA, PO, IC; Phase 2: tender documents)

Downloads that run by themselves for each IREPS account, shared by every DocLink user of that account: Bill
Status, CRN and R-NOTE once a morning; MA, POs and ICs every hour, each run fetching only what is new. The design, decisions and API contract are in `schedular_implementation_plan.md`
(Appendix A is the contract with the Recon Engine).

**Switch.** `config.json` (or `config.local.json`, which replaces the whole block):

```json
"schedular_phase1": { "enabled": true, "documents": ["BillStatus", "CRN", "RNote", "MA", "PO", "IC"] }
```

* Scheduling is on only when `enabled` is the JSON value `true` and `documents` names at least one known type.
  Anything else (false, missing, `"true"`, an empty list, an unreadable config) is off: no alarm, no request,
  no Schedule view.
* `documents` names what this DocLink may trigger: `IC` covers ICs by IC date and ICs from notifications, `PO` is
  POs by PO date. Remove a name and that type is never triggered automatically; manual downloads are unchanged.
  Names ignore case; an unknown name is ignored and shown in the Schedule view, and it stops a build.
* The repo ships `"enabled": false`. A build that schedules sets it to `true` once the Recon Engine has the
  schedule endpoints. The build log prints the setting.
* This block is the one documented exception to "no new config.json keys" (asked for on 2026-11-16).

**Schedules** are kept in the Recon Engine per IREPS account and type (`/api/doclink/schedules`): a daily
window (IST), how often it runs (**once a day**, or once per period: every 30 min / hour / 2 hours / 3 hours), a
retry interval for a run that has not happened yet (10 / 15 / 30 / 60 min), weekdays (default every day) and a
look-back in days (the date range a run searches: MA / PO / IC 2).

**Bill Status, CRN and R-NOTE always search the last 90 days** (since 19 Nov 2026), whatever look-back a
schedule holds: Bill Status with IREPS's own "Last 90 Days", CRN and R-NOTE with the 90 days up to the claim's
today (the Recon Engine's date, IST; `scheduledSearch` in `services/scheduler/run-details.js`). Their box shows
"Date range: Last 90 days" instead of a look-back field, and a save stores 90. Each export is saved where an
"ECM / S3" export of the panel goes: the Recon Engine's `POST /api/documents` with its `doc_type`, stored under
`bronze/<customer>/bill_status/`, `.../crn/` or `.../rnote/` and loaded into the reconciliation data. A new
schedule starts with these timings:

| Type | Window (IST) | Runs | Retry until done |
|---|---|---|---|
| Bill Status, CRN, R-NOTE | 09:00-10:00 | once a day | every 10 min |
| MA, POs by PO date, ICs by IC date, ICs from notifications | 09:00-18:00 | every hour (09:00, 10:00, … 18:00) | every 15 min within the hour |

Admins (`doclink.schedule.manage`) edit them in the panel's **Scheduled downloads** view (clock icon in the
header). Each type is a box like the panel's other option boxes, its title line showing the timing ("09:00-10:00 ·
once a day") or "Off" / "Not scheduled"; opened, it holds On / Off, From and To (hour and minute dropdowns, IST),
Runs, Retry, Look back (a fixed "Last 90 days" for Bill Status, CRN and R-NOTE) and the days, with **Save** and
**Delete** (or **Add schedule**). A new schedule can be added only for a type this DocLink runs
(tender types only with `schedular_phase2` on), and an existing schedule of any type stays editable. The view is
drawn again whenever the scheduler's state changes (every few minutes while downloads run); a box with changes
not saved yet, or one being used (an open dropdown), is kept as it is, so a Save always sends what the admin set.

**A time changed during the day.** Today's slot of a once-a-day schedule takes the new window when it has not
run: pending, waiting for a retry, or missed in its old window; a missed slot whose new window has not ended is
open again, so the new time runs today. A slot that is done (or running) keeps its day: the new time applies from
tomorrow. This is the Recon Engine's rule (`PUT /api/doclink/schedules/{id}`); a Recon Engine that only moves a
pending slot (before the 19 Nov 2026 patch, `Wabtec/docs/patches/2026-11-19-recon-schedule-time-change-and-90-days.patch`)
leaves a missed slot as it is, and the view then says "Saved. Today's Bill Status slot (09:00-10:00) has ended
and was not reopened by the Recon Engine: the new time 11:00-12:00 applies from tomorrow."

Everyone sees what ran today. An hourly type shows its
latest run, the next run, and the earlier runs of the day folded into one line ("Earlier today: 3 of 4 runs
done, 12 saved"). A slot that has not run reads "Scheduled 18:00-19:00" before its window, "Due 18:00-19:00, not
run yet" inside it, and "Not run during 09:00-10:00" once missed. What this DocLink waits for (an IREPS login, a
manual run, the Recon Engine) and its last failed check ("Last check failed: …") are in the line at the top.

**What failed, and why.** A row of Today opens (▸) to the details of its run:
* the range it searched ("Searched: Last 90 Days", "Searched: 21/08/2026 - 18/11/2026"), when it ran and who ran it
  ("this browser" for this DocLink's own runs), the counts, the file it saved ("Saved to: s3://…"), why it
  stopped ("Why: IREPS session expired (…)") and the attempts so far;
* **every document not saved, with its reason**: "Tender 10263703 - Annexure 4: ECM unavailable (the ECM did not
  answer in time)", "PO 1234: PO download failed (IREPS returned HTTP 500)", "IC 45 (PO 123 Sr. 1): ECM refused the
  document (No such property: …)". The reason is the real one: an upload the ECM refused is not reported as a
  download error. The slot's result (kept by the Recon Engine, seen by every user of the account) carries the
  first 20 and how many more; this browser's own runs show them all;
* warnings of a tender run (an IREPS letter list it could not read, messages it could not match to a tender);
* for an hourly type, the earlier runs of the day that did not end clean, each with its failed documents;
* for a slot that did not run (missed, or due and waiting), what this browser's scheduler noted during its window,
  for example "09:02-09:50 (6 checks): Due now: Bill Status, CRN, R-NOTE. Waiting for IREPS: no IREPS page has
  loaded in this browser in the last 4 minutes".

**Run log of this browser** (a box under Today, `services/scheduler/run-log.js`, `chrome.storage.local`
`doclink.scheduler.runLog`): every scheduled run this DocLink made (the last 60), each opening to the documents it
could not save (with why), skipped ("Already saved by Priya on …") and saved (where: "IC_45.pdf in ECM /…", the
S3 path of an export), and the scheduler's decisions (the last 200: waiting for IREPS, for a manual run, for the
Recon Engine; another DocLink running the account; a claim given back; a schedule changed). A decision repeated at
every check is one line with its count. **Copy log** and **Save log** give the whole log as text (IST times) for
support. The DocLink log (`doclinkLog.dump()`) has the same decisions and one line per document not saved.
Only document numbers, error codes and DocLink's own texts are kept, cut short and redacted: never a URL, an
IREPS page, a token or a cookie.

**Each slot once, by one DocLink.** A once-a-day schedule makes one slot per day; an hourly one makes one slot
per hour (09:00-10:00, 10:00-11:00, …): for a repeating schedule the window's end is the start of the last
run, so the 18:00 run is the last one and may run until 19:00. A DocLink may run a slot only when its user
holds `doclink.schedule.run`, is signed in to the Recon Engine, and is logged in to IREPS on that account. The
Recon Engine hands each slot to exactly one DocLink (an atomic claim with a 10-minute lease, renewed by a
heartbeat every 2 minutes) and runs one slot per account at a time, so the hourly types run one after the
other. When a slot is `done`, no DocLink triggers it again: a once-a-day type waits for tomorrow, an hourly type
for the next hour. A slot not done by its end is `missed`. Each hourly run searches the look-back range and the
reservations skip every document already saved, so a run downloads only what is new, and a missed hour is
caught up by the next run.

**Order of checks** (`services/scheduler/scheduler.js`): config on → Recon signed in with
`doclink.schedule.run` → last verified IREPS account known → `GET /schedule/due` → no manual job running here →
an IREPS page loaded in this browser in the last 4 minutes → claim → **one** IREPS check (the home page: logged
in, same account) → run. Nothing is sent to IREPS before the claim is won, and never on a timer: twenty DocLinks
waking at 09:00 send one IREPS request between them. A run starts at the alarm, when an IREPS page finishes
loading (a user who logs in at 09:07 runs the 09:00 slot at once; without a page load the next check is 09:10), when the panel's IREPS check passes, after a
Recon sign-in, or when a manual job ends.

**Never twice, never local** (`services/scheduler/shared-run-hooks.js`):

* Before anything is fetched, every document key (`downloadKey`) is reserved for the run's claim
  (`/api/doclink/documents/reserve`). A key anyone already saved for the account and destination (scheduled or
  manual, from the download log) is skipped without a question: "Already saved by Priya on 2026-11-17 at 09:08".
  A reservation that fails downloads nothing.
* Exports go to the Recon Engine (S3), PDFs to the ECM, whatever the panel's Save to switch says. There is no
  local fallback: a refused upload is a failed document, the slot ends `partial`, and the next check fetches
  only what is missing. The IC notifications manifest file is not written.
* Every saved document is reported with its download-log record (`/api/doclink/documents/complete`), so the next
  reservation by anyone sees it at once. If that report cannot be sent, the records go to the normal download-log
  queue.
* Before each upload the run must still hold its claim (a heartbeat within the lease); a run that lost its claim
  stops, and the DocLink that took over skips what is already done.

**Outcomes.** `done` (saved, or nothing new); `partial` (some documents failed: retried at the next check);
`failed` (retried at the next check; an expired IREPS session or a busy local job gives the slot back without
counting an attempt); `failed_final` (a setting a retry cannot fix); `missed`. The toolbar icon shows `!` while a
slot of this account waits for an IREPS login in this browser.

**Code.** `services/scheduler/` (`schedule-types.js` setting and types, `schedule-api.js` Recon client,
`local-signals.js` IREPS activity / account, `scheduler.js` the checks and claims, `runners.js` outcomes,
`shared-run-hooks.js` reserve / save / report, `run-details.js` the searched range and the failure entries,
`run-log.js` this browser's run log), `background/scheduler-job.js` (alarm, tabs, badge, Schedule view
messages), `popup/popup-schedule.js`. The worker's jobs are started through `launch*` functions whose `done`
promise the scheduler awaits; a panel click uses the same functions. Tests: `test/scheduler-tests.js`
(`npm test -- browser --only=scheduler`).

**Not scheduled:** single PO / IC downloads by PO number, a single tender by tender number, and anything while
Chrome is closed.

### Phase 2: tender documents

**Switch.** Its own block, beside `schedular_phase1` (config.local.json may replace it whole):

```json
"schedular_phase2": { "enabled": true, "documents": ["NIT", "CounterOffer", "LOA", "Tabulation", "Correspondence", "Negotiation"] }
```

Same rules as phase 1: on only with `enabled: true` and a known name; names ignore case; a phase 1 name in
this block (or the other way round) is unknown and stops a build. Either block switches scheduling on. The repo
ships it off.

| Name | Schedule type | What a run does (with the claim's date range) | Default timing (IST) |
|---|---|---|---|
| `NIT` | `tenderNit` | "NIT Documents" (automatic mode): My Messages in the range → each tender's NIT, attachments, My Offer and its corrigenda | hourly, 10:30 … 18:30 |
| `CounterOffer` | `tenderCounterOffer` | Counter Offer letters by Letter Date | hourly, 10:30 … 18:30 |
| `LOA` | `tenderLoa` | Advance Acceptance (LOA) letters by Letter Date. Sends IREPS's own "LOA viewed" request first, as a manual LOA download does, with nobody clicking | hourly, 10:30 … 18:30 |
| `Tabulation` | `tenderTabulations` | Financial and Commercial Tabulation of tenders closing in the range (look-back 15 days: a tabulation appears days after closing) | hourly, 10:30 … 18:30 |
| `Correspondence` | `tenderCorrespondence` | Every letter IREPS lists as pending (no date range) | hourly, 10:30 … 18:30 |
| `Negotiation` | `tenderNegotiation` | Negotiation letters by Letter Date. Its own schedule because IREPS opens these pages very slowly | 12:30, 15:30, 18:30 (retry every 30 min) |

Every hourly run is retried every 15 minutes within its hour; the 18:30 run is the last. Each run fetches only
what is new: the reservations skip every document anyone saved for the account.

**Where it runs.** The tender code needs a page (it reads IREPS pages with `DOMParser` and prints letters with
Chrome's print-to-PDF), so the DocLink that wins a tender slot opens `tender/schedule-runner.html` in a
**background tab** (not focused), runs the job there and closes the tab when it ends. While a letter or corrigendum
is printed, Chrome briefly shows "DocLink started debugging this browser", as in a manual run. A user who closes
the tab stops the run; the slot is given back without counting an attempt, and another DocLink may run it.
A run is given 50 minutes at most.

**Same guarantees as phase 1** (`tender/tender-shared-run.js`, `shared-run-hooks.js` `tenderHooks`):

* Every document is reserved for the IREPS account before it is fetched (tender documents per category,
  correspondence per letter, keys from `downloadKey.tender` / `downloadKey.pending`). One anyone already saved is
  skipped without the "download again?" question; a reservation that fails fetches nothing.
* The ECM only (NIT, LOA and Result as grouped documents, direct ECM), never Downloads: a refused upload is a
  failed document, retried at the next check. No `.html` copy of a rendered letter is kept.
* Each saved file is reported with its download-log record. The run must still hold its claim before each upload
  (the tab asks the worker every 20 s; the worker sends the heartbeats).
* A scheduled run keeps its own tender ledger (`<account>#scheduled`), so a document the user once downloaded to
  Local never makes it skip that document.
* The Recon sign-in page is never shown in the runner tab: the scheduler checked the sign-in before it claimed.
* The run is for the account the worker verified: another IREPS account logged in stops it before any download.

**Code.** `services/scheduler/tender-runner.js` (opens and closes the tab, the job, the outcome),
`tender/schedule-runner.html` / `schedule-runner.js` (the tab), `tender/tender-shared-run.js` (the switch inside
the tender code). Tests: `test/scheduler-tests.js`, and "Scheduled run" in `tender/tests/run-tests.mjs` and
`tender/tests/pending-tests.mjs`.

