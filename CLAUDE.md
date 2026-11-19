# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Everyone who develops DocLink, with or without Claude, follows the **Coding standards** and the **Definition of done** below; the **Working rules for Claude Code** apply to Claude in every session.

## What this is

**DocLink**: a Chrome Manifest V3 extension (Chrome 116+) that automates document downloads from the Indian Railways IREPS portal (Bill Status, CRN, R-NOTE, MA, PO, Inspection Certificates, tender documents, correspondence) and creates draft supplier bills in IREPS (Upload Bill to IREPS). It saves files locally, to the Recon Engine (S3), or to the Wabtec ECM (Nuxeo). It acts as an authenticated browser client. It sends `fetch(..., { credentials: "include" })` and Chrome attaches the IREPS cookies. It never reads, stores or logs credentials, cookies or Struts tokens.

The repo is plain ES modules with no framework and no runtime dependencies. You load it unpacked from the repo root. `README.md` is the detailed spec, organized by feature section. `TESTING.md` is the manual and acceptance test guide. `upload.md` is the API study behind **Upload Bill to IREPS** (README section 20). `01_api_data/` (gitignored) holds the HAR captures and specs the request formats were taken from.

## Commands

The commands work in PowerShell, Git Bash, macOS and Linux.

```bash
# Every suite: the browser suite in headless Chrome, the node:test suites, and the bill-flow check.
# Chrome is found at its usual install path (or set CHROME_PATH); each run uses a throwaway Chrome profile.
# The exit code is 0 only when everything passed.
npm test
npm test -- browser                    # only the browser suite (test/run-tests.html)
npm test -- browser --only=po,ic       # only some browser suites: the names are set in test/run-tests.js ("core" = run-tests.js itself)
npm test -- node                       # only the node:test suites (tender/tests/*.mjs, test/node/*.mjs)
npm test -- bill                       # only the bill-upload check against the mock bill screens

npm run lint                           # ESLint (eslint.config.js)
npm run verify                         # lint + every test + build: run it before every pull request

# One node test file, or one test by name:
node --test tender/tests/run-tests.mjs
node --test test/node/config-tests.mjs
node --test --test-name-pattern="ECM direct" tender/tests/run-tests.mjs

# Bill upload code against the mock bill screens (no browser; its own mock on port 8799, BILL_CHECK_PORT=<port> to move it)
node test/mock/bill-flow-check.mjs

# Mock IREPS portal (http://localhost:8765, scenario control panel at /mock/, bill upload test hub at /mock/bill/)
node test/mock/mock-ireps-server.mjs
node test/mock/switch-target.mjs mock|real|status   # same as editing config.json "target"

# Sample PDF from the dependency-free PDF writer
node test/make-sample-pdf.mjs /tmp/sample.pdf

# Shareable build: bundles + minifies + obfuscates each entry point into dist/doclink/ and zips it.
npm install && npm run build                       # production build (see below)
npm run build -- --allow-mock                      # test build: may run against the mock portal
npm run build -- --allow-mock --log-level=debug    # the same, with debug logs
```

The two builds differ:
- **A plain `npm run build` is the production build.**
  - It requires `"target": "real"`.
  - It drops the mock and localhost host permissions from the built manifest and logs from info up.
  - It stops when config.json holds what looks like a real credential (8 or more characters under a credential key), or when a URL DocLink uses points at localhost or is not covered by the remaining permissions.
- **A `--allow-mock` build is for testing.** It accepts any target and keeps every host permission. Its `version_name` says "test build".
- **Every build** stamps the git commit (short SHA, "-dirty" when there are uncommitted changes) into the manifest's `version_name` and into `build-info.json`.
- **Builds are reproducible.** The tool versions are pinned and the obfuscator seed is fixed.
- **The obfuscator's control-flow flattening stays off.** In javascript-obfuscator 4.2.2 it can route a spread call through a two-argument helper and drop arguments. In a 15 Nov 2026 build it did this to `utils/logger.js`, and the panel's console lines lost their message. The other obfuscator options are unaffected.

About the browser suite:
- A test that has not finished after 10 seconds fails by name, so one hanging test cannot hide the summary.
- When the page gives no `DOCLINK_TESTS n/n` summary at all, the runner syntax-checks every module and prints the first errors.
- Headless Chrome's virtual clock behaves unlike real time:
  - it stops while a stream read is pending;
  - it runs on while module files load, so a fresh `import()` "takes" seconds.

  Tests of stalled responses, and tests that need a fresh copy of a module, belong in `test/node/`, not in the browser suite.

After code changes, reload DocLink in `chrome://extensions`.

## Configuration

- `config.json` is hand-edited and read at runtime through `chrome.runtime.getURL("config.json")`. `"target": "mock" | "real"` selects the IREPS origin. It also holds the Recon Engine URL, the Okta app, the `downloadLog` switch, `ecmBackendAws`, and the `ecm` settings. Ship builds with `"target": "real"`.
- **Fail closed.** Inside the extension, a config.json that cannot be read, or whose `"target"` is neither `"real"` nor `"mock"`, leaves NO IREPS URL. The panel shows "DocLink configuration error" (`IREPS_NOT_CONFIGURED`) and nothing is sent; DocLink never falls back to the mock portal. Only test pages and Node keep the mock as their default.
- `config.local.json` is gitignored and never packaged. It has the same shape and overrides `config.json`: top-level keys replace, and `ecm` merges key by key. Real ECM client credentials go there, never in `config.json`. A `config.local.json` that is present but not valid JSON is reported as an error and ignored.
- Both files are read only through `readConfigFiles()` in `utils/config.js`, once per page or worker; `force` reads them again. Every settings loader (`loadIrepsConfig`, `loadReconConfig`, `loadEcmConfig`, `loadDownloadLogConfig`; tender's `getBaseUrl` calls `loadIrepsConfig`) builds on it. Don't add another `fetch("config.json")`.
- `"schedular_phase1": { "enabled", "documents" }` (non-tender documents) and `"schedular_phase2": { "enabled", "documents" }` (tender documents) switch scheduled downloads on for a build and name the types it may trigger (`services/scheduler/schedule-types.js`, README section 23). They are the exceptions to the "no new config.json key" rule below, added at the user's request on 16 and 17 Nov 2026 and still waiting for the tech lead's sign-off. Each block is on only with `enabled: true` and a known type of its phase; the repo ships both off.
- Every origin a config URL points to (IREPS mock/real, Recon, ECM domain) must also be in `manifest.json` `host_permissions`. If it is missing, the extension reports a configuration error and sends nothing.
## Architecture

**Runtime contexts.** MV3 service workers have no DOM, so the work is split:
- `background/service-worker.js` orchestrates the Bill Status / CRN / R-NOTE / MA / PO / IC jobs and the batches. A `handlers` map is keyed by `MESSAGE_TYPES` (`utils/messages.js`). Each message first awaits `loadIrepsConfig()` and then dispatches.
  - Job state lives in the worker, so closing the panel doesn't cancel a run. The panel restores state via `GET_*_STATE`.
  - Every job body runs inside `holdWorker()` (`background/keep-alive.js`). It keeps Chrome's worker alive while a job runs with a local `chrome.runtime.getPlatformInfo()` call every 20 s, never an IREPS request.
  - Each job saves its state in `chrome.storage.session`, and `restoreSavedJob` reads it back after a worker restart. A run that Chrome cut off shows as "Download interrupted"; it never vanishes.
- `background/offscreen.js` owns `DOMParser`. The worker sends it HTML to parse, for example `PARSE_BILL_STATUS`, always through `withOffscreen`: it opens and closes the document one step at a time and closes it only after 30 s without a user. Because of this, flow functions take an injected `parseHtml`, and tests pass the parser directly.
- `popup/popup.html` is the UI, rendered in Chrome's **side panel**, with one panel per tab.
  - The worker opens each tab's panel as `popup.html?tabId=<id>`, and `panelOwnTabId()` (`popup/popup-gate.js`) is how a panel recognises its own runs.
  - `utils/url-scope.js` + `popup/popup-gate.js` show the tools only when the tab is on the configured portal.
  - Feature UIs are split into `popup/popup-*.js` modules. Shared helpers are in `popup/popup-common.js`, `utils/dates.js` and `asDescribedError` (`utils/messages.js`). `showView()` (popup.js) is the only view switch and also hides the tender views.
- `tender/` is a separate feature that runs **inside the side panel itself**, not the service worker. It is loaded by `popup.html` via `tender/tender-ui.js` and `tender/pending-ui.js`, and it calls IREPS directly.
  - It has its own core (`tender-core.js`: fetch wrapper, errors, the write guard), account detection, ledger (`chrome.storage.local`), and workflows.
  - `tender/run-lock.js` allows one tender / correspondence run per panel. `startTenderJob` (`tender-account.js`) is the shared run start. `tender/view-common.js` holds what both tender views share. Tender logs go through `utils/logger.js` via `tender-core.js` `log()`.
  - Documents arrive two ways and both must keep working:
    - real files (PDF etc.) are kept as served;
    - page-view letters / corrigenda are printed to PDF by Chrome through `chrome.debugger` (`tender-print.js`; the `debugger` permission), with a text PDF + original HTML fallback when printing is not allowed.
  - Its tests run in Node with a `FakeIreps` server (`tender/tests/fake-ireps.js`) and a fake `chrome` global.

**IREPS request pattern.** IREPS is a Struts app.
- Each flow loads the form page, validates the session from the **HTML content** (HTTP 200 is never trusted; `services/session-service.js`), extracts the single-use Struts TOKEN from the page, POSTs the search, and parses result tables. On a consumed token, the flow reloads and retries once.
- Parsers find tables by header labels, never by position, and report `structure` ("table" / "none").
- "Nothing found" is only what IREPS says: an empty result table, "Total Records: 0", or a "No Record Found" message. A results page DocLink does not recognise is an error, never zero results.
- IREPS keeps one Struts token per session, and every form load replaces it. So every "load the form -> search -> token-bound pages" sequence runs under `withIrepsFormLock` (`services/ireps-form-lock.js`, a Web Lock shared by the worker and every panel). The panel's session check and the PO Search form load never wait behind a running search: they answer from it. PDF downloads are not locked.
- Shared modules:
  - All PO-Search document types (CRN, R-NOTE, MA, PO) share `services/search-po/` (API, form, table, pagination, export, `document-downloader.js`). Every result page is followed, and the records read are compared with IREPS's own total.
  - The three IC flows (one PO, IC by date, IC from notifications) share `runIcSearch` in `services/inspection-certificate/ic-search.js`.
  - The batch workflows (PO by date, IC by date, IC notifications) share their download/state/retry half in `services/batch-download.js`.
  - Form-scraping helpers (`stripComments`, `findAllTags`, `locateFormIn`) live in `services/ireps-form.js`; `isIrepsOriginUrl` / `rewrapTransportError` in `services/ireps-api.js`.
  - Per-type parsers, exports and services live in `services/<type>/`. `icFiling` / `poFiling` say how an IC / PO is filed in the ECM and keyed in the download log.
- Request bodies mirror HAR captures exactly, so don't "clean up" odd fields such as the duplicate `searchCriteria`.
- IREPS logs a user out by itself after about 5 minutes idle, and DocLink then shows "Login required". That is correct: never add requests that keep the IREPS session alive.
- **Railways reuse tender numbers** (10263703 is a N F RLY and an EAST CENTRAL RLY tender).
  - When a tender search returns a number more than once, `searchTender` takes the row that fits the caller's `prefer` hints (`preferredRows` in `tender/tender-search.js`):
    - the letter list row's railway (`closingDateFor`);
    - the NIT message's due date (automatic mode).
  - A hint that fits no row leaves the old choice (the row with the most actions), and the hints add no request.
  - Pass a hint whenever the caller knows the tender's railway or due date.

**Save-to destinations.** One Local | ECM / S3 switch (stored value `recon`) applies to every download:
- Bill Status / CRN / R-NOTE exports (.xlsx) go to the Recon Engine `POST /api/documents` (`services/recon-service.js`), through `saveExportFile` in `services/export-save-service.js` (which also does the download-log "identical export" check on the exported rows).
- IC / PO / MA / tender PDFs go to the ECM. With `ecmBackendAws: true` they go through the Recon gateway `POST /api/ecm/documents` (`services/ecm-service.js`). With `false` they go directly to Nuxeo (`services/ecm-direct.js`). Folders, kinds, titles and metadata fields come from `services/ecm-catalog.js`, which is a copy of the recon-engine repo's `backend/ECM/ecm_client/config/` and must stay in step with the gateway's `document_kinds.toml`.
- If the ECM refuses a document, it **falls back to a local save** with an `ECM_*` reason, so nothing is lost. An IREPS account that can't be verified (`utils/ireps-account.js`: 833 = Hosur, 60828 = Rohtak) is never guessed. Its documents are saved locally.
- **Tender documents in the ECM.** NIT, LOA and the Financial Tabulation are *grouped* kinds (`group: true` in `ecm-catalog.js`, as the Wabtec team asked on 2026-10-29): **one document per tender**, titled `<T> - NIT`, `<T> - LOA` and `<T> - Result` (type `tenderResult`, the ECM's "Tender Result").
  - The first PDF becomes the main file (`file:content`). Later ones are appended to `files:files` with Nuxeo's `Blob.AttachOnDocument` (`addToTenderDocument` in `ecm-direct.js`).
  - PDFs inside are told apart by file name, so an LOA's ECM file name always carries its letter id (`ecmFileName` in `tender/tender-ecm.js`).
  - In a full run, attachments wait for the tender PDF (`run.nitPdfSaved`), so the tender PDF is the main file.
  - The download check skips the ECM lookup for grouped kinds (`ecmCheckDocumentFor`).
  - **Grouped kinds are direct-ECM only.** The gateway can't add attachments, so with `ecmBackendAws: true` they're refused and saved locally.
  - Corrigenda, NBSP, CO, CRP and the Commercial Tabulation (`vct`) stay one document per PDF.
  - Every tender document carries `tender_date` (the IREPS closing date). `vft` remains in the catalog, in step with the gateway, but is unused.
  - The client asked for the LOA fields and the correspondence tender date on 13 Nov 2026. The tech lead decided on 15 Nov 2026 that they ship without a setting. An LOA also carries:
    - `loi_number`, the number printed on the letter: `<Dept> / <Tender No> / <LetterId>`, e.g. `DAHOD / 61265711C / 1503282`;
    - `loi_date`, the LOA list row's Letter Date.

    Both are built from the LOA list row (`loaFields` in `tender/tender-ecm.js`; "Dept/Rly. Unit" is found by its header), and DocLink sends both or neither.
  - The correspondence tender date is the "Closing Date" next to the tender number on the correspondence page. That is the tender's closing date; the letter's own deadline is "Last date for submission of reply".
- The ECM's live schema and type vocabulary are the source of truth. Check them with `GET /nuxeo/api/v1/config/schemas/InvoiceCertificateSchema` and `GET /nuxeo/api/v1/directory/invoice_certificate_document_types` before adding a field or kind. A property the schema lacks makes Nuxeo answer HTTP 400 "No such property".

**Two logins.** Login 1 is IREPS (manual, security key). DocLink only checks it. Login 2 is the Recon Engine (password or Okta via `chrome.identity`; `services/recon-auth.js`, `popup/popup-recon-auth.js`). The Recon login is required for every run while `downloadLog.enabled` is true. When the Recon Engine cannot be reached at all (as opposed to nobody being signed in), the sign-in page also offers "Download without the Recon Engine": the run saves locally and its log records wait in the queue.

**Extension ID and Okta.** The public `"key"` in `manifest.json` pins the extension ID to `cglncbgakabfoenpkbaoigpclmgkklcl` for every copy (unpacked from any folder, or the `dist/` build). The Okta app's sign-in redirect URI is `https://cglncbgakabfoenpkbaoigpclmgkklcl.chromiumapp.org/okta` (`okta.redirectPath`). No sign-out redirect is needed, because Sign out only ends the Recon session. Changing or removing `"key"` changes the ID and breaks Okta sign-in. The matching private key (`doclink-key.pem`) is kept outside the repo and must never be committed, shared or packaged. It's only needed to publish to the Chrome Web Store.

**Scheduled downloads (Phase 1).** Bill Status, CRN and R-NOTE run by themselves once a day (default 09:00-10:00 IST, retried every 10 min), MA, POs by date and ICs every hour (default 09:00 to 18:00, the last run at 18:00, each run fetching what is new), per IREPS account and shared by every DocLink user (README section 23, `schedular_implementation_plan.md`; Appendix A is the API contract with the Recon Engine's `/api/doclink/schedule*` and `/api/doclink/documents/*`).
- The Recon Engine keeps the schedules and gives each slot to exactly one DocLink: an atomic claim with a 10-minute lease and a 2-minute heartbeat, one slot per account at a time. A `done` slot is never run again (a once-a-day schedule has one slot per day, an hourly one a slot per hour).
- `services/scheduler/scheduler.js` holds the order of checks. Nothing goes to IREPS before this DocLink has won a claim, and never on a timer: the winner makes ONE IREPS request (the home page: logged in, same account), and only right after an IREPS page loaded in this browser. Keep it that way: it is what keeps IREPS from being polled or kept alive.
- A scheduled run reuses the worker's jobs through `launch*` functions (each returns a `done` promise; the panel's handlers strip it). `services/scheduler/shared-run-hooks.js` replaces the per-user pieces: every document is reserved for the account before download, saved to S3 / ECM only (never local, no ECM-to-local fallback, no IC manifest file), and reported with its log record. A failed reservation downloads nothing.
- `background/scheduler-job.js` is the chrome.* side (the `alarms` permission, `tabs.onUpdated`, the badge, the Schedule view's messages). The scheduler core, runners and hooks take their dependencies, so `test/scheduler-tests.js` runs them on fakes.
- **What a run tells.** Every document a scheduled run does not save is named with its code and reason (`failureEntry` in `services/scheduler/run-details.js`; the hooks keep the saver's real reason, never the downloader's "Chrome could not save the file"; the tender code reports through `documentFailed`). The slot's `result` sent with `finish` carries `range`, `detail`, the first 20 `failures` and `failuresMore` (cut by `fitResult` to stay under the Recon Engine's 16,000-character limit); this browser's run log (`run-log.js`, `chrome.storage.local`) keeps the full lists and the scheduler's decisions (`note()` in `scheduler.js`). Only document numbers, codes and DocLink's own texts go in, redacted: never a URL, page, token or cookie. A run-log write never fails a run.
- **Bill Status, CRN and R-NOTE search the last 90 days** whatever the schedule's look-back (`scheduledSearch` / `FIXED_LOOKBACK` in `run-details.js`, `exportLaunchOptions` in `scheduler-job.js`; asked for on 19 Nov 2026). CRN and R-NOTE count the 90 days back from the claim's `dateTo` (the Recon Engine's today), never the laptop's clock unless the claim has none.
- **The Schedule view keeps an edit.** The worker's state messages redraw the view; a schedule box with unsaved changes (or the focus) is kept as it is (`dirtyEditors` / `editorBoxes` in `popup/popup-schedule.js`). Today's once-a-day slot takes a new time only through the Recon Engine (`PUT /api/doclink/schedules/{id}`, which reopens a missed slot from the 19 Nov 2026 patch in `Wabtec/docs/patches/`); the view says when a change applies from tomorrow instead.
- **Phase 2 (tender documents)**: NIT, Counter Offer, LOA, Tabulations, Correspondence hourly 10:30 to 18:30, Negotiation at 12:30, 15:30 and 18:30. The tender code needs a page, so the worker runs a claimed tender slot in a background tab (`services/scheduler/tender-runner.js` opens and closes it; `tender/schedule-runner.js` runs the job and answers READY / PING / DONE; the worker answers only the tab it opened). Inside the tender code, `tender/tender-shared-run.js` switches a run to the shared pieces: reserve before fetch (`checkAlreadyDownloaded`, each correspondence letter), ECM only (`tenderEcmSink`; `createSaver` refuses a local save), report each save, a separate `#scheduled` ledger, no sign-in page. Nothing is installed outside the runner tab, so manual tender runs are unchanged.

**Download log.** `services/download-log.js` records every save to the Recon Engine (`/api/doclink/downloads`).
- Before a run, it checks which docs this user already downloaded to the same destination, and whether they are already in the ECM.
- Dedup keys are built from document numbers, never file names (`downloadKey`). Exports use a fingerprint of their rows instead.
- The log never blocks a run: if it's unavailable, everything downloads.
- Records queue in `chrome.storage.local`, one queue per context ("sw", "panel"), and every change to a queue runs under a Web Lock.
- Each record is stamped with the Recon user who saved it and is posted only while that user is signed in.
- A batch the backend refuses outright (400/413/422) is split, and only the refused records are set aside (`doclink.downloadLog.rejected`).

**Network to the Recon Engine, ECM and download log.** Every request has one deadline that covers the headers and the body: `fetchWithDeadline` in `utils/http.js`. ECM uploads run one at a time in every context: in order within a page or the worker, and under the Web Lock `doclink.ecm.upload` across them. The TEST ECM damaged documents that were created at the same moment. An ECM file counts as damaged only after a definite bad read (short or missing); a temporary error (5xx, timeout, network) is retried and otherwise leaves the document unchanged.

**Error codes.** Every user-facing failure is a code (`IREPS_*`, `RECON_*`, `ECM_*`, `OKTA_*`, ...) resolved to text by `describeError` in `utils/messages.js`. Add new errors there, not as inline strings.

## Conventions and invariants

- No runtime dependencies. XLSX, ZIP and PDF are written by hand (`utils/xlsx-writer.js`, `utils/zip-writer.js`, `services/pdf-service.js`). esbuild and javascript-obfuscator are build-only.
- IREPS values are reproduced verbatim. `----`, `-`, `NA`, `N/A` and empty become `null`. Nothing is calculated or de-duplicated. CSV cells that Excel would run as formulas get a leading apostrophe (`csvSafeText`); plain numbers stay as IREPS gave them.
- Log through `utils/logger.js`, which redacts tokens, cookies, secrets, API keys, JSON tokens and the Struts token field. Never log tokens, cookies or ECM secrets.
- Read-only toward IREPS, with one exception: **Upload Bill to IREPS** (`services/bill-upload/`, `background/bill-upload-job.js`, `popup/popup-bill-upload.js`).
  - What it writes, each step only after the user starts it:
    - the draft bill (`saveBillHeader.do`, `saveBillDetails.do`);
    - the bill's documents: each is signed by the user in the IREPS signer (`wss://127.0.0.1:2175`, with their own DSC and PIN; DocLink never signs), stored with `/cgi-bin/save.php` and registered with `uploadBillDocuments.do`.
  - The bill's final Sign & Submit stays manual in IREPS.
  - Those calls run inside the user's IREPS tab via `chrome.scripting` (`tab-transport.js`), and request bodies keep the HAR's field order (`orderedBody`).
- Tender and correspondence requests all go through one write guard, `requestRefusal` in `tender/tender-core.js`. It runs on the final URL and body of every request, refuses write actions (submit, save, update, delete, withdraw, approve, logout, ...), and also covers every request a print tab's page makes (`printRequestRefusal` in `tender-print.js`).
  - The one documented exception is the LOA "viewed" POST (`LOA_VIEWED_UPDATE` in `tender-core.js`: `ajxdata.do`, `ajaxMode=updateLoaViewedDataByBidder`, numeric ids only). IREPS's own "View LOA Letter" button sends it before opening the letter, and DocLink does the same, only with the values read from IREPS's live LOA script. If they can't be read, that LOA fails clearly and nothing is sent.
  - The tech lead accepted this write on 15 Nov 2026: it is the same request IREPS's own "View LOA Letter" button sends.
  - Scheduled LOA downloads (Phase 2, `tenderLoa`) send it too, with nobody clicking. The user chose this on 17 Nov 2026; the tech lead's approval should be extended to cover it. Remove `LOA` from `schedular_phase2.documents` to keep LOAs manual.
- Of the tabulations, only Financial and Commercial are allowed: any other `pdfType` and any "techno" file name are blocked. `TECH-TAB-<no>-<oid>.pdf` is IREPS's name for the Commercial Tabulation, not a Techno-Commercial one. It passes only inside a `commercialTabulation` response (`isExcludedTrustedLink`).
- A new JS entry point loaded by HTML or the manifest must be added to `ENTRY_POINTS` in `scripts/build.mjs` (or to `PANEL_ENTRY_POINTS` if it is a `<script>` of `popup/popup.html`), and new static files to `STATIC_FILES`. Otherwise the built extension won't include them. The panel scripts are bundled together with code splitting so their shared modules (download log, print queue) exist once, as they do unpacked. The build refuses `"target": "mock"` unless run with `-- --allow-mock`.
- When you add a browser test suite, export a `run*Tests({ test, assert, eq, ... })` function and `await` it from `test/run-tests.js` after a `currentSuite = "<name>";` line, so `--only=<name>` can select it.

## Coding standards

These rules come from the November 2026 code review and the fixes that followed it. A change that breaks one of them needs a stated reason in its pull request.

**IREPS**
- "Nothing found" only when IREPS says so. A page DocLink does not recognise is an error with a code, never zero results. New parsers report `structure`.
- Match document numbers exactly. Never use "the first row" or "the first PDF" without checking that it belongs to the document asked for.
- Follow every result page, and compare the records read with IREPS's own total. A shortfall is a visible warning, never a silent partial list.
- Run every form sequence under `withIrepsFormLock`. Never call a locked function from inside another one (Web Locks are not re-entrant).
- Keep request URLs and bodies exactly as captured. Before code relies on a new IREPS page or answer (error pages included), capture it from the live portal and add it to the fixtures and the mock.
- Never add a write to IREPS outside the documented bill upload exception. Never keep the IREPS session alive.

**Network**
- Use `fetchWithDeadline` for the Recon Engine, ECM and download log. A deadline must cover the body, not just the headers.
- Tell transient failures (network, timeout, 5xx) from definite ones (a 4xx refusal). Retry or keep data on a transient failure; never delete or replace data because of one.
- Broken or missing settings never fall back silently to another system (the mock portal, a staging server). Fail closed, with an error code the panel shows.
- Secrets never go in a URL. Credentials go in a request body or header.
  - Known exception, pending the ECM team: the direct-mode ECM token request sends the client id / secret in the URL, as ECM_API_DOC shows it and as DocLink always has.
  - When the ECM team confirms that the token endpoint accepts them in the form body, change `requestToken` in `services/ecm-direct.js`. There is no setting for it.
- The ECM (Nuxeo) is a third-party system. Change what DocLink sends to it (endpoints, query strings, headers, bodies, order) only when the tech lead decides so, and check the change on the TEST ECM. Don't put such a change behind a setting.

**Service worker and panel**
- A long job runs inside `holdWorker()`, saves its state through its `setXState` function, and is read back by `restoreSavedJob` after a worker restart.
- A failed side effect (a footer line, a log record) never turns a finished download into a failed run.
- A run's questions ("download again?") are answered by the panel that started the run, not by whichever tab is active.
- Parse IREPS HTML only through `withOffscreen`. Never open or close the offscreen document by hand.

**Download log and data**
- Log keys are document numbers (`downloadKey`). Queue changes go through the download-log module only (Web Lock, user stamp).
- Record the file name Chrome actually used, not the one requested.

**Logging and errors**
- Log only through `utils/logger.js`. When a new kind of secret appears (a header, a field), add a redaction test for it.
- Every user-facing failure is an error code with plain text that says what happened and what the user can do.

**Code style**
- Plain ES modules, no runtime dependencies, LF line endings.
- Keep the style of the file you edit (`tender/*` and the rest differ; don't mix them within one file). Don't reformat code you are not changing: formatting is its own commit.
- Small functions with one job. JSDoc on exported functions. Comments explain why, not what.
- A user-visible behaviour change updates the README section that describes it. A rule or architecture change updates this file.

## Definition of done (every change)

1. **Tests.** A test that fails without the change (check it by undoing the change once), and `npm test` passes.
2. **Lint.** `npm run lint` passes.
3. **The end-to-end gate before a client build.** This applies when the change touches IREPS requests, the ECM, the Recon Engine, the download log or the service worker. Run the built extension against the mock portal and compare it with the last build that worked on live IREPS: the same flows, the same requests, and only differences you intended.
4. **Docs.** The README and this file match the code.
5. **Safety.** No secrets, no `config.local.json`, no `doclink-key.pem` and no client documents in the commit. Work on a branch; changes reach `main` only through a reviewed pull request.

## Working rules for Claude Code

- Run `npm test` before you say a change is done, and report the exact counts. If anything fails, show the failure; never call failing work finished.
- Commit, push or open a pull request only when asked. Work on a branch, never directly on `main`.
- Ask first before you:
  - change an IREPS request format or add any request that writes to IREPS;
  - add a runtime dependency or a `manifest.json` permission;
  - change ECM metadata fields or kinds (check the live schema first);
  - remove a feature, or change the `"key"`.
- When the right behaviour depends on an IREPS page or answer that isn't captured, say so and stop instead of guessing.
- Make the smallest change that solves the task. Don't refactor or reformat unrelated code in the same change.
- Don't add a setting or a new `config.json` key that switches new behaviour on or off. `config.json` keeps the shape it had before the November 2026 refactor (the tech lead's decision). Build the behaviour to work by default, and say plainly when a change carries a risk.
- Never read, print or store `config.local.json` secrets, cookies, tokens or the user's IREPS data beyond what the task needs.
