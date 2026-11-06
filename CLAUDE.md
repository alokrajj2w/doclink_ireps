# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**DocLink**: a Chrome Manifest V3 extension (Chrome 116+) that automates document downloads from the Indian Railways IREPS portal (Bill Status, CRN, R-NOTE, MA, PO, Inspection Certificates, tender documents, correspondence). It saves files locally, to the Recon Engine (S3), or to the Wabtec ECM (Nuxeo). It acts as an authenticated browser client. It sends `fetch(..., { credentials: "include" })` and Chrome attaches the IREPS cookies. It never reads, stores or logs credentials, cookies or Struts tokens.

The repo is plain ES modules with no framework and no runtime dependencies. You load it unpacked from the repo root. `README.md` is the detailed spec, organized by feature section. `TESTING.md` is the manual and acceptance test guide. `upload.md` is the API study behind **Upload Bill to IREPS** (README section 20). `01_api_data/` (gitignored) holds the HAR captures and specs the request formats were taken from.

## Commands

```bash
# Browser test suite (parsers, flows with fake fetch, writers, ECM, download log, ...).
# All suites under test/*.js are imported and run by test/run-tests.js. There is no per-test filter.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --allow-file-access-from-files --virtual-time-budget=20000 \
  --dump-dom "file://$PWD/test/run-tests.html" | grep -o 'DOCLINK_TESTS[^<]*'
# To see failures, drop the grep and look at the <li class="fail"> entries in the dumped DOM.

# Tender / correspondence node tests (node:test). jsdom is NOT installed in this repo;
# point JSDOM_ROOT at any directory whose node_modules has jsdom (`npm i jsdom` in a scratch dir).
JSDOM_ROOT=/path/to/dir node --test tender/tests/run-tests.mjs
JSDOM_ROOT=/path/to/dir node --test tender/tests/pending-tests.mjs
# Single tender test:
JSDOM_ROOT=/path/to/dir node --test --test-name-pattern="ECM direct" tender/tests/run-tests.mjs

# Mock IREPS portal (http://localhost:8765, scenario control panel at /mock/)
node test/mock/mock-ireps-server.mjs
node test/mock/switch-target.mjs mock|real|status   # same as editing config.json "target"

# Sample PDF from the dependency-free PDF writer
node test/make-sample-pdf.mjs /tmp/sample.pdf

# Shareable build: bundles + minifies + obfuscates each entry point into dist/doclink/ and zips it
npm install && npm run build
```

There is no linter. After code changes, reload DocLink in `chrome://extensions`.

## Configuration

- `config.json` is hand-edited and read at runtime through `chrome.runtime.getURL("config.json")`. `"target": "mock" | "real"` selects the IREPS origin. It also holds the Recon Engine URL, the Okta app, the `downloadLog` switch, `ecmBackendAws`, and the `ecm` settings. Ship builds with `"target": "real"`.
- `config.local.json` is gitignored and never packaged. It has the same shape and overrides `config.json`: top-level keys replace, and `ecm` merges key by key. Real ECM client credentials go there, never in `config.json`.
- Every origin a config URL points to (IREPS mock/real, Recon, ECM domain) must also be in `manifest.json` `host_permissions`. If it is missing, the extension reports a configuration error and sends nothing.

## Architecture

**Runtime contexts.** MV3 service workers have no DOM, so the work is split:
- `background/service-worker.js` orchestrates the Bill Status / CRN / R-NOTE / MA / PO / IC jobs. A `handlers` map is keyed by `MESSAGE_TYPES` (`utils/messages.js`). Each message first awaits `loadIrepsConfig()` and then dispatches. Job state lives in the worker, so closing the panel doesn't cancel a run. The panel restores state via `GET_JOB_STATE`.
- `background/offscreen.js` owns `DOMParser`. The worker sends it HTML to parse, for example `PARSE_BILL_STATUS`. Because of this, flow functions take an injected `parseHtml`, and tests pass the parser directly.
- `popup/popup.html` is the UI, rendered in Chrome's **side panel**, with one panel per tab. `utils/url-scope.js` + `popup/popup-gate.js` show the tools only when the tab is on the configured portal. Feature UIs are split into `popup/popup-*.js` modules.
- `tender/` is a separate feature that runs **inside the side panel itself**, not the service worker. It is loaded by `popup.html` via `tender/tender-ui.js` and `tender/pending-ui.js`, and it calls IREPS directly. It has its own core (`tender-core.js`: fetch wrapper, errors, `isExcludedUrl` guard), account detection, ledger (`chrome.storage.local`), and workflows. Its tests run in Node with a `FakeIreps` server (`tender/tests/fake-ireps.js`) and a fake `chrome` global.

**IREPS request pattern.** IREPS is a Struts app. Each flow loads the form page, validates the session from the **HTML content** (HTTP 200 is never trusted; `services/session-service.js`), extracts the single-use Struts TOKEN from the page, POSTs the search, and parses result tables. Parsers find tables by header labels, never by position. On a consumed token, the flow reloads and retries once. All PO-Search document types (CRN, R-NOTE, MA, PO) share `services/search-po/` (API, form, table, pagination, export, `document-downloader.js`). Per-type parsers, exports and services live in `services/<type>/`. Request bodies mirror HAR captures exactly, so don't "clean up" odd fields such as the duplicate `searchCriteria`.

**Save-to destinations.** One Local | ECM / S3 switch (stored value `recon`) applies to every download:
- Bill Status / CRN / R-NOTE exports (.xlsx) go to the Recon Engine `POST /api/documents` (`services/recon-service.js`).
- IC / PO / MA / tender PDFs go to the ECM. With `ecmBackendAws: true` they go through the Recon gateway `POST /api/ecm/documents` (`services/ecm-service.js`). With `false` they go directly to Nuxeo (`services/ecm-direct.js`). Folders, kinds, titles and metadata fields come from `services/ecm-catalog.js`, which is a copy of the recon-engine repo's `backend/ECM/ecm_client/config/` and must stay in step with the gateway's `document_kinds.toml`.
- If the ECM refuses a document, it **falls back to a local save** with an `ECM_*` reason, so nothing is lost. An IREPS account that can't be verified (`utils/ireps-account.js`: 833 = Hosur, 60828 = Rohtak) is never guessed. Its documents are saved locally.
- **Tender documents in the ECM.** NIT, LOA and the Financial Tabulation are *grouped* kinds (`group: true` in `ecm-catalog.js`, as the Wabtec team asked on 2026-10-29): **one document per tender**, titled `<T> - NIT`, `<T> - LOA` and `<T> - Result` (type `tenderResult`, the ECM's "Tender Result"). The first PDF becomes the main file (`file:content`), and later ones are appended to `files:files` with Nuxeo's `Blob.AttachOnDocument` (`addToTenderDocument` in `ecm-direct.js`). PDFs inside are told apart by file name, so an LOA's ECM file name always carries its letter id (`ecmFileName` in `tender/tender-ecm.js`). In a full run, attachments wait for the tender PDF (`run.nitPdfSaved`), so the tender PDF is the main file. The download check skips the ECM lookup for grouped kinds (`ecmCheckDocumentFor`). **Grouped kinds are direct-ECM only.** The gateway can't add attachments, so with `ecmBackendAws: true` they're refused and saved locally. Corrigenda, NBSP, CO, CRP and the Commercial Tabulation (`vct`) stay one document per PDF. Every tender document carries `tender_date` (the IREPS closing date). `vft` remains in the catalog, in step with the gateway, but is unused.
- The ECM's live schema and type vocabulary are the source of truth. Check them with `GET /nuxeo/api/v1/config/schemas/InvoiceCertificateSchema` and `GET /nuxeo/api/v1/directory/invoice_certificate_document_types` before adding a field or kind. A property the schema lacks makes Nuxeo answer HTTP 400 "No such property".

**Two logins.** Login 1 is IREPS (manual, security key). DocLink only checks it. Login 2 is the Recon Engine (password or Okta via `chrome.identity`; `services/recon-auth.js`, `popup/popup-recon-auth.js`). The Recon login is required for every run while `downloadLog.enabled` is true.

**Extension ID and Okta.** The public `"key"` in `manifest.json` pins the extension ID to `cglncbgakabfoenpkbaoigpclmgkklcl` for every copy (unpacked from any folder, or the `dist/` build). The Okta app's sign-in redirect URI is `https://cglncbgakabfoenpkbaoigpclmgkklcl.chromiumapp.org/okta` (`okta.redirectPath`). No sign-out redirect is needed, because Sign out only ends the Recon session. Changing or removing `"key"` changes the ID and breaks Okta sign-in. The matching private key (`doclink-key.pem`) is kept outside the repo and must never be committed, shared or packaged. It's only needed to publish to the Chrome Web Store.

**Download log.** `services/download-log.js` records every save to the Recon Engine (`/api/doclink/downloads`). Before a run, it checks which docs this user already downloaded to the same destination, and whether they are already in the ECM. Dedup keys are built from document numbers, never file names (`downloadKey`). Exports use a fingerprint of their rows instead. The log never blocks a run: if it's unavailable, everything downloads. Records queue in `chrome.storage.local`.

**Error codes.** Every user-facing failure is a code (`IREPS_*`, `RECON_*`, `ECM_*`, `OKTA_*`, ...) resolved to text by `describeError` in `utils/messages.js`. Add new errors there, not as inline strings.

## Conventions and invariants

- No runtime dependencies. XLSX, ZIP and PDF are written by hand (`utils/xlsx-writer.js`, `utils/zip-writer.js`, `services/pdf-service.js`). esbuild and javascript-obfuscator are build-only.
- IREPS values are reproduced verbatim. `----`, `-`, `NA`, `N/A` and empty become `null`. Nothing is calculated or de-duplicated.
- Log through `utils/logger.js`, which redacts `TOKEN=` and similar secrets. Never log tokens, cookies or ECM secrets.
- Read-only toward IREPS, with one exception: **Upload Bill to IREPS** (`services/bill-upload/`, `background/bill-upload-job.js`, `popup/popup-bill-upload.js`) writes the draft bill (`saveBillHeader.do`, `saveBillDetails.do`), only after the user confirms. Those `/epsn/ct/*` calls run inside the user's IREPS tab via `chrome.scripting` (`tab-transport.js`), and request bodies keep the HAR's field order (`orderedBody`). Signing and submitting stay manual in IREPS. Tender and correspondence code refuses write actions (`assertReadOnly`, `isExcludedUrl`). Of the tabulations, only Financial and Commercial are allowed: any other `pdfType` and any "techno" file name are blocked. `TECH-TAB-<no>-<oid>.pdf` is IREPS's name for the Commercial Tabulation, not a Techno-Commercial one. It passes only inside a `commercialTabulation` response (`isExcludedTrustedLink`).
- A new JS entry point loaded by HTML or the manifest must be added to `ENTRY_POINTS` in `scripts/build.mjs`, and new static files to `STATIC_FILES`. Otherwise the built extension won't include them.
- When you add a browser test suite, export a `run*Tests({ test, assert, eq, ... })` function and `await` it from `test/run-tests.js`.
