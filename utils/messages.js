/**
 * Message types, workflow stages and user-facing error texts shared by the
 * popup, the service worker, the offscreen document and the preview page.
 */

export const MESSAGE_TYPES = Object.freeze({
  // popup -> service worker (request / response)
  CHECK_IREPS_SESSION: "CHECK_IREPS_SESSION",
  DOWNLOAD_IREPS_BILL_STATUS: "DOWNLOAD_IREPS_BILL_STATUS",
  GET_JOB_STATE: "GET_JOB_STATE",
  OPEN_IREPS: "OPEN_IREPS",
  GET_TAB_SCOPE: "GET_TAB_SCOPE",
  OPEN_PREVIEW: "OPEN_PREVIEW",
  // opens the Recon Engine (config.json reconAppUrl) so the user can sign in for "Save to: Recon Engine (S3)"
  OPEN_RECON: "OPEN_RECON",

  // popup -> service worker: PO Search document workflows (CRN, R-NOTE), separate from Bill Status
  SEARCH_PO_LOAD_FORM: "SEARCH_PO_LOAD_FORM",
  DOWNLOAD_IREPS_DOCUMENTS: "DOWNLOAD_IREPS_DOCUMENTS",
  GET_DOCUMENT_JOB_STATE: "GET_DOCUMENT_JOB_STATE",

  // popup -> service worker: MA copies (search, then per-MA PDF downloads)
  MA_SEARCH: "MA_SEARCH",
  MA_DOWNLOAD: "MA_DOWNLOAD",
  GET_MA_STATE: "GET_MA_STATE",
  MA_RESET: "MA_RESET",

  // popup -> service worker: PO / Inspection Certificate download (one PO number, two independent downloads)
  PO_DOWNLOAD: "PO_DOWNLOAD",
  GET_PO_STATE: "GET_PO_STATE",
  IC_DOWNLOAD: "IC_DOWNLOAD",
  GET_IC_STATE: "GET_IC_STATE",

  // popup -> service worker: batch downloads (PO by date, IC from notifications)
  BATCH_START: "BATCH_START",
  BATCH_RETRY: "BATCH_RETRY",
  BATCH_GET_STATE: "BATCH_GET_STATE",

  // popup -> service worker: bill upload (ECM invoice -> IREPS supplier bill, services/bill-upload/)
  BILL_UPLOAD_SEARCH: "BILL_UPLOAD_SEARCH",
  BILL_UPLOAD_PREPARE: "BILL_UPLOAD_PREPARE",
  BILL_UPLOAD_REVIEW: "BILL_UPLOAD_REVIEW",
  BILL_UPLOAD_CREATE: "BILL_UPLOAD_CREATE",
  BILL_UPLOAD_SAVE_ITEM: "BILL_UPLOAD_SAVE_ITEM",
  BILL_UPLOAD_DOCUMENTS: "BILL_UPLOAD_DOCUMENTS",
  BILL_UPLOAD_GET_STATE: "BILL_UPLOAD_GET_STATE",
  BILL_UPLOAD_RESET: "BILL_UPLOAD_RESET",
  BILL_UPLOAD_FORGET: "BILL_UPLOAD_FORGET",
  BILL_UPLOAD_ADD_DOCUMENT: "BILL_UPLOAD_ADD_DOCUMENT",
  // Phase 1 scheduled downloads (services/scheduler/, background/scheduler-job.js)
  SCHEDULE_GET_STATE: "SCHEDULE_GET_STATE",
  SCHEDULE_NUDGE: "SCHEDULE_NUDGE",
  SCHEDULE_LIST: "SCHEDULE_LIST",
  SCHEDULE_SAVE: "SCHEDULE_SAVE",
  SCHEDULE_DELETE: "SCHEDULE_DELETE",
  // Phase 2: the background runner tab of a tender slot (tender/schedule-runner.js -> worker)
  SCHEDULE_RUNNER_READY: "SCHEDULE_RUNNER_READY",
  SCHEDULE_RUNNER_PING: "SCHEDULE_RUNNER_PING",
  SCHEDULE_RUNNER_DONE: "SCHEDULE_RUNNER_DONE",

  // service worker -> popup (broadcast)
  IREPS_PROGRESS: "IREPS_PROGRESS",
  IREPS_DOWNLOAD_COMPLETE: "IREPS_DOWNLOAD_COMPLETE",
  IREPS_DOWNLOAD_ERROR: "IREPS_DOWNLOAD_ERROR",
  DOCUMENT_PROGRESS: "DOCUMENT_PROGRESS",
  DOCUMENT_DOWNLOAD_COMPLETE: "DOCUMENT_DOWNLOAD_COMPLETE",
  DOCUMENT_DOWNLOAD_ERROR: "DOCUMENT_DOWNLOAD_ERROR",
  MA_PROGRESS: "MA_PROGRESS",
  MA_SEARCH_COMPLETE: "MA_SEARCH_COMPLETE",
  MA_DOWNLOAD_PROGRESS: "MA_DOWNLOAD_PROGRESS",
  MA_DOWNLOAD_COMPLETE: "MA_DOWNLOAD_COMPLETE",
  MA_ERROR: "MA_ERROR",
  PO_PROGRESS: "PO_PROGRESS",
  PO_DOWNLOAD_COMPLETE: "PO_DOWNLOAD_COMPLETE",
  PO_DOWNLOAD_ERROR: "PO_DOWNLOAD_ERROR",
  IC_PROGRESS: "IC_PROGRESS",
  IC_DOWNLOAD_PROGRESS: "IC_DOWNLOAD_PROGRESS",
  IC_DOWNLOAD_COMPLETE: "IC_DOWNLOAD_COMPLETE",
  IC_DOWNLOAD_ERROR: "IC_DOWNLOAD_ERROR",
  BATCH_UPDATE: "BATCH_UPDATE",
  BILL_UPLOAD_UPDATE: "BILL_UPLOAD_UPDATE",
  SCHEDULE_STATE: "SCHEDULE_STATE",

  // service worker -> popup (request / response): "these files are already downloaded /
  // in the ECM - download which again?" (services/download-log.js, popup/popup-redownload.js)
  CONFIRM_REDOWNLOAD: "CONFIRM_REDOWNLOAD",

  // service worker -> offscreen document
  PARSE_BILL_STATUS: "PARSE_BILL_STATUS",
  PARSE_SEARCH_PO_RESULTS: "PARSE_SEARCH_PO_RESULTS",
  PARSE_IC_RESULTS: "PARSE_IC_RESULTS",
  PARSE_IREPS_ACCOUNT: "PARSE_IREPS_ACCOUNT"
});

/** Routing targets so broadcast messages are only handled where intended. */
export const TARGETS = Object.freeze({
  SERVICE_WORKER: "service-worker",
  OFFSCREEN: "offscreen",
  POPUP: "popup"
});

/** Workflow stages in order. `label` is what the popup displays. */
export const STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Connecting to IREPS..." },
  FETCHING: { id: "FETCHING", label: "Retrieving Bill Status..." },
  PROCESSING: { id: "PROCESSING", label: "Processing bills..." },
  GENERATING_FILE: { id: "GENERATING_FILE", label: "Generating Excel..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading..." },
  COMPLETE: { id: "COMPLETE", label: "Bill Status downloaded successfully" },
  ERROR: { id: "ERROR", label: "Error" }
});

/**
 * PO Search document workflow stages (CRN, R-NOTE), independent of the Bill
 * Status stages above. `{type}` is replaced with the document label.
 */
export const DOCUMENT_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS PO Search..." },
  SEARCHING: { id: "SEARCHING", label: "Searching {type}s..." },
  PAGING: { id: "PAGING", label: "Loading {type} result pages..." },
  PARSING: { id: "PARSING", label: "Reading {type} records..." },
  GENERATING_FILE: { id: "GENERATING_FILE", label: "Building the export file..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading..." },
  COMPLETE: { id: "COMPLETE", label: "{type} export downloaded successfully" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** MA copies workflow stages. */
export const MA_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS PO Search..." },
  SEARCHING: { id: "SEARCHING", label: "Searching Modification Advices..." },
  PAGING: { id: "PAGING", label: "Loading MA result pages..." },
  PARSING: { id: "PARSING", label: "Reading MA records..." },
  READY: { id: "READY", label: "MA results ready" },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading MA copies..." },
  COMPLETE: { id: "COMPLETE", label: "MA download finished" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** Single Purchase Order (PO) download workflow stages. */
export const PO_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS PO Search..." },
  SEARCHING: { id: "SEARCHING", label: "Searching PO..." },
  PARSING: { id: "PARSING", label: "Reading PO details..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading PO..." },
  COMPLETE: { id: "COMPLETE", label: "PO downloaded successfully" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** Inspection Certificate (IC) download workflow stages (search, then per-IC PDF downloads). */
export const IC_STAGES = Object.freeze({
  IDLE: { id: "IDLE", label: "" },
  CHECKING_SESSION: { id: "CHECKING_SESSION", label: "Checking IREPS session..." },
  CONNECTED: { id: "CONNECTED", label: "Loading IREPS Inspection Call List..." },
  SEARCHING: { id: "SEARCHING", label: "Searching issued ICs..." },
  PARSING: { id: "PARSING", label: "Reading IC records..." },
  DOWNLOADING: { id: "DOWNLOADING", label: "Downloading Inspection Certificates..." },
  COMPLETE: { id: "COMPLETE", label: "IC download finished" },
  ERROR: { id: "ERROR", label: "Error" }
});

/** Stage label with the document type filled in ("CRN", "R-NOTE"). */
export function documentStageLabel(stage, typeLabel) {
  return String(stage.label || "").replace(/\{type\}/g, typeLabel || "document");
}

/**
 * Business-friendly error catalogue keyed by error code.
 *
 * `message` may contain "{detail}" which is substituted with a short,
 * user-safe detail supplied by the workflow (for example
 * "IREPS returned HTTP 500"). `connection` drives the header indicator.
 */
export const ERROR_CATALOG = Object.freeze({
  IREPS_NOT_CONFIGURED: {
    title: "IREPS not configured",
    message: "DocLink has no usable IREPS address ({detail}). Check config.json (\"target\": \"real\" or \"mock\", and the portal URL) and manifest.json host_permissions, then reload DocLink. Nothing was sent.",
    connection: "connected"
  },
  IREPS_SESSION_EXPIRED: {
    title: "IREPS login required",
    message: "IREPS session expired. Please log in to IREPS and try again.",
    loginRequired: true,
    connection: "login"
  },
  IREPS_REQUEST_FAILED: {
    title: "Unable to retrieve Bill Status",
    message: "DocLink could not complete the request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_TOKEN_NOT_FOUND: {
    title: "IREPS form token not found",
    message: "The IREPS page did not contain the expected form token. Reload IREPS, then try again.",
    connection: "offline"
  },
  IREPS_INVALID_RESPONSE: {
    title: "Unable to load Bill Status",
    message: "IREPS Bill Status page could not be loaded.",
    connection: "offline"
  },
  IREPS_PARSE_FAILED: {
    title: "Unable to read the Bill Status records",
    message: "Bill Status was received from IREPS, but DocLink could not read the result.",
    connection: "connected"
  },
  IREPS_NO_RECORDS: {
    title: "No Bill Records Found",
    message: "No Bill Status records were found for the selected search criteria.",
    notice: true,
    connection: "connected"
  },
  IREPS_INVALID_REQUEST: {
    title: "Invalid search options",
    message: "{detail}",
    notice: true
  },
  EXPORT_ERROR: {
    title: "Bill Status Retrieved",
    message: "However, DocLink could not create the Excel file.",
    connection: "connected"
  },
  PDF_ERROR: {
    title: "Bill Status Retrieved",
    message: "However, DocLink could not generate the PDF.",
    previewAvailable: true,
    connection: "connected"
  },
  DOWNLOAD_ERROR: {
    title: "Excel File Created",
    message: "However, Chrome could not save the file. Check your download settings and retry.",
    previewAvailable: true,
    connection: "connected"
  },
  BUSY: {
    title: "Download Already Running",
    message: "Please wait for the current download to finish."
  },

  /* ------------------------------------------------ PO Search documents */
  IREPS_SEARCH_PAGE_FAILED: {
    title: "Unable to open IREPS PO Search",
    message: "DocLink could not load the IREPS PO Search page ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  UNSUPPORTED_IREPS_SEARCH_TYPE: {
    title: "Unsupported IREPS search type",
    message: "DocLink does not know this PO Search document type ({detail})."
  },
  IREPS_CRN_SEARCH_FAILED: {
    title: "Unable to search CRNs",
    message: "DocLink could not complete the CRN search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_CRN_RESULTS_INVALID: {
    title: "Unable to recognise the CRN results",
    message: "IREPS did not return the CRN search results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_CRN_NOT_FOUND: {
    title: "No CRNs Found",
    message: "IREPS returned successfully, but no Consignment Receipt Notes matched the selected search.",
    notice: true,
    connection: "connected"
  },
  IREPS_CRN_PARSE_FAILED: {
    title: "Unable to read the CRN records",
    message: "IREPS returned the CRN results page, but DocLink could not extract the CRN records from it.",
    connection: "connected"
  },
  IREPS_RNOTE_SEARCH_FAILED: {
    title: "Unable to search R-NOTEs",
    message: "DocLink could not complete the R-NOTE search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_RNOTE_RESULTS_INVALID: {
    title: "Unable to recognise the R-NOTE results",
    message: "IREPS did not return the R-NOTE search results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_RNOTE_NOT_FOUND: {
    title: "No R-NOTEs Found",
    message: "IREPS returned successfully, but no Receipt Notes matched the selected search.",
    notice: true,
    connection: "connected"
  },
  IREPS_RNOTE_PARSE_FAILED: {
    title: "Unable to read the R-NOTE records",
    message: "IREPS returned the R-NOTE results page, but DocLink could not extract the Receipt Note records from it.",
    connection: "connected"
  },
  IREPS_MA_SEARCH_FAILED: {
    title: "Unable to search Modification Advices",
    message: "DocLink could not complete the MA search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_MA_RESULTS_INVALID: {
    title: "Unable to recognise the MA results",
    message: "IREPS did not return the Modification Advice results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_MA_NOT_FOUND: {
    title: "No MA copies found",
    message: "No Modification Advice matched the selection: {detail}.",
    notice: true,
    connection: "connected"
  },
  IREPS_MA_PARSE_FAILED: {
    title: "Unable to read the MA records",
    message: "IREPS returned the Modification Advice results page, but DocLink could not extract the MA records from it.",
    connection: "connected"
  },
  IREPS_MA_LINK_NOT_FOUND: {
    title: "MA copy link not found",
    message: "IREPS did not provide a \"View/Download MA\" link for this Modification Advice ({detail}).",
    connection: "connected"
  },
  IREPS_MA_DOWNLOAD_FAILED: {
    title: "MA copy download failed",
    message: "DocLink could not download the MA PDF from IREPS ({detail}).",
    connection: "connected"
  },
  IREPS_MA_INVALID_PDF: {
    title: "MA copy not valid",
    message: "IREPS did not return a PDF for this Modification Advice ({detail}). Nothing was saved.",
    connection: "connected"
  },
  MA_SESSION_EXPIRED_DURING_DOWNLOAD: {
    title: "IREPS session expired",
    message: "Your IREPS session has expired.\n\nPlease log in again and retry the MA download.",
    connection: "login"
  },
  MA_BUSY: {
    title: "MA Task Already Running",
    message: "Please wait for the current MA search or download to finish."
  },
  MA_NO_SELECTION: {
    title: "No MA selected",
    message: "Select at least one Modification Advice, or use Download All.",
    notice: true
  },
  DOCUMENT_EXPORT_ERROR: {
    title: "Records retrieved",
    message: "However, DocLink could not build the export file.",
    connection: "connected"
  },
  DOCUMENT_DOWNLOAD_ERROR: {
    title: "Export generated",
    message: "However, Chrome could not save the file. Check your download settings and retry.",
    connection: "connected"
  },

  /* ------------------------------------- Recon Engine sign-in (the second login, not IREPS) */
  RECON_SIGNIN_INVALID: {
    title: "Recon Engine sign-in failed",
    message: "The email or password is not right for the Recon Engine. This is your joulestowatts Recon account, not the IREPS login.",
    connection: "connected"
  },
  RECON_SIGNIN_NO_ACCESS: {
    title: "No Recon Engine access",
    message: "This Recon Engine account has no access yet. Please contact the Recon Engine admin.",
    connection: "connected"
  },
  RECON_SIGNIN_LOCKED: {
    title: "Too many sign-in attempts",
    message: "The Recon Engine paused sign-in for this email after several failed attempts. Wait 5 minutes, then try again.",
    connection: "connected"
  },
  RECON_SIGNIN_UNAVAILABLE: {
    title: "Recon Engine unavailable",
    message: "DocLink could not reach the Recon Engine to sign in ({detail}). Check that it is running, or save locally.",
    connection: "connected"
  },
  OKTA_NOT_CONFIGURED: {
    title: "Okta sign-in not set up",
    message: "Okta sign-in is not available: {detail}. Sign in with your Recon Engine email and password instead.",
    connection: "connected"
  },
  OKTA_CANCELLED: {
    title: "Okta sign-in cancelled",
    message: "The Okta window was closed before sign-in finished. Nothing changed.",
    connection: "connected"
  },
  OKTA_REDIRECT_NOT_REGISTERED: {
    title: "Okta does not know DocLink yet",
    message: "Okta refused DocLink's sign-in address. Ask the Okta admin to add {detail} as a sign-in redirect URI of the Recon Engine Okta app, or sign in with your email and password.",
    connection: "connected"
  },
  OKTA_FAILED: {
    title: "Okta sign-in failed",
    message: "Okta sign-in did not complete ({detail}). Try again, or sign in with your email and password.",
    connection: "connected"
  },
  OKTA_NO_ACCESS: {
    title: "No Recon Engine access",
    message: "Okta signed you in, but this person has no Recon Engine access. Please contact the Recon Engine admin.",
    connection: "connected"
  },
  OKTA_INACTIVE: {
    title: "Recon Engine account deactivated",
    message: "Okta signed you in, but this Recon Engine account is deactivated. Please contact the Recon Engine admin.",
    connection: "connected"
  },

  /* ------------------------------------- Save to: Recon Engine (S3) */
  RECON_NOT_CONFIGURED: {
    title: "Recon Engine not configured",
    message: "DocLink cannot save to the Recon Engine: {detail}. Set reconBaseUrl in config.json (and add it to host_permissions in manifest.json), then reload DocLink.",
    connection: "connected"
  },
  RECON_AUTH_REQUIRED: {
    title: "Recon Engine sign-in required",
    message: "Sign in to the Recon Engine (your joulestowatts or Okta account, not the IREPS login), then try again. Nothing was saved.",
    reconSignIn: true,
    connection: "connected"
  },
  RECON_UNAVAILABLE: {
    title: "Recon Engine unavailable",
    message: "The IREPS records were retrieved, but DocLink could not reach the Recon Engine ({detail}). Try again, or save locally.",
    connection: "connected"
  },
  RECON_REJECTED: {
    title: "Recon Engine refused the file",
    message: "The Recon Engine did not accept the upload: {detail}. Nothing was saved.",
    connection: "connected"
  },
  RECON_NOT_INGESTED: {
    title: "Saved to S3, not loaded",
    message: "The file was stored by the Recon Engine, but it could not be loaded into reconciliation: {detail}",
    notice: true,
    connection: "connected"
  },

  /* ------------------------------ Save to: ECM / S3 (IC, PO, MA, tender documents) */
  // Per document: a failed ECM upload is saved locally instead and the row says why.
  ECM_NOT_CONFIGURED: {
    title: "ECM not configured",
    message: "DocLink could not save to the ECM: {detail}. The document was saved locally.",
    notice: true,
    connection: "connected"
  },
  ECM_ACCOUNT_UNKNOWN: {
    title: "IREPS account not verified",
    message: "DocLink could not tell which IREPS account (unit) is signed in, so it did not pick an ECM folder. The document was saved locally.",
    notice: true,
    connection: "connected"
  },
  ECM_AUTH_REQUIRED: {
    title: "Recon Engine sign-in required",
    message: "Sign in to the Recon Engine (your joulestowatts or Okta account, not the IREPS login) to save to the ECM. The document was saved locally.",
    reconSignIn: true,
    notice: true,
    connection: "connected"
  },
  ECM_REJECTED: {
    title: "ECM refused the document",
    message: "The ECM did not accept the document: {detail}. It was saved locally.",
    notice: true,
    connection: "connected"
  },
  ECM_UNAVAILABLE: {
    title: "ECM unavailable",
    message: "DocLink could not reach the ECM ({detail}). The document was saved locally.",
    notice: true,
    connection: "connected"
  },
  ECM_FILE_DAMAGED: {
    title: "ECM copy is damaged",
    message: "The ECM holds this document but cannot serve its file in full ({detail}). It was saved locally; ask the ECM team to remove the damaged copy.",
    notice: true,
    connection: "connected"
  },
  DOWNLOAD_LOG_SIGN_IN_REQUIRED: {
    title: "Recon Engine sign-in required",
    message: "Sign in to the Recon Engine to download: DocLink records every download for the signed-in user, and checks what you already downloaded. Nothing was downloaded.",
    reconSignIn: true
  },
  DOWNLOAD_LOG_UNAVAILABLE: {
    title: "Download log unavailable",
    message: "DocLink could not reach the Recon Engine's download log ({detail}). The files are downloaded anyway and recorded once it is back.",
    notice: true
  },
  DOCUMENT_BUSY: {
    title: "Download Already Running",
    message: "Please wait for the current CRN / R-NOTE download to finish."
  },

  /* ------------------------------------------------------- Tender documents and correspondence (tender/) */
  TENDER_PAGE_NOT_RECOGNISED: {
    title: "IREPS page not recognised",
    message: "IREPS answered with a page DocLink does not recognise ({detail}). DocLink did not take it as \"nothing found\": open the page in IREPS to check, then retry."
  },
  TENDER_LIST_FAILED: {
    title: "IREPS list not read",
    message: "IREPS did not return the list ({detail}). Documents on it may be missing from this download: retry it."
  },
  TENDER_SEARCH_INCOMPLETE: {
    title: "Tender search incomplete",
    message: "DocLink could not tell whether the tender is in IREPS ({detail}). Retry the download."
  },
  TENDER_SEARCH_SHORT: {
    title: "Tender search not read in full",
    message: "DocLink read fewer tenders than IREPS listed ({detail}). Tabulations of the tenders not read may be missing: retry the download."
  },
  TENDER_REQUEST_BLOCKED: {
    title: "Request refused",
    message: "DocLink did not send this request to IREPS because it looks like an action that changes something in IREPS ({detail}). DocLink only reads and downloads."
  },
  TENDER_LOA_SCRIPT_UNREADABLE: {
    title: "LOA not requested",
    message: "DocLink could not read how IREPS's \"View LOA Letter\" link opens this letter ({detail}), so it did not tell IREPS the letter was viewed and did not request it. Open the LOA in IREPS, or retry later."
  },

  /* ------------------------------------------------------- PO download */
  IREPS_PO_SEARCH_FAILED: {
    title: "Unable to search for the PO",
    message: "DocLink could not complete the PO search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_PO_RESULTS_INVALID: {
    title: "Unable to recognise the PO results",
    message: "IREPS did not return the PO search results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_PO_NOT_FOUND: {
    title: "Purchase Order not found",
    message: "Purchase Order {detail} was not found (or is not visible to your IREPS account).",
    notice: true,
    connection: "connected"
  },
  IREPS_PO_PARSE_FAILED: {
    title: "Unable to read the PO details",
    message: "IREPS returned the PO search results page, but DocLink could not extract the PO details from it.",
    connection: "connected"
  },
  IREPS_PO_LINK_NOT_FOUND: {
    title: "PO document link not found",
    message: "IREPS did not provide a \"View/Download PO\" link for this Purchase Order ({detail}).",
    connection: "connected"
  },
  IREPS_PO_DOWNLOAD_FAILED: {
    title: "PO download failed",
    message: "DocLink could not download the PO PDF from IREPS ({detail}).",
    connection: "connected"
  },
  IREPS_PO_INVALID_PDF: {
    title: "PO document not valid",
    message: "IREPS did not return a PDF for this Purchase Order ({detail}). Nothing was saved.",
    connection: "connected"
  },
  PO_BUSY: {
    title: "PO Download Already Running",
    message: "Please wait for the current PO download to finish."
  },

  /* --------------------------------------- Inspection Certificate (IC) */
  IREPS_IC_SEARCH_FAILED: {
    title: "Unable to search Inspection Certificates",
    message: "DocLink could not complete the Inspection Certificate search request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_IC_RESULTS_INVALID: {
    title: "Unable to recognise the IC results",
    message: "IREPS did not return the Inspection Call List results page ({detail}). The page structure may have changed, or IREPS reported an error.",
    connection: "connected"
  },
  IREPS_IC_TOKEN_NOT_FOUND: {
    title: "IREPS form token not found",
    message: "The IREPS Inspection Call List page did not contain the expected form token. Reload IREPS, then try again.",
    connection: "offline"
  },
  IREPS_IC_PARSE_FAILED: {
    title: "Unable to read the IC records",
    message: "IREPS returned the Inspection Call List results page, but DocLink could not extract the IC records from it.",
    connection: "connected"
  },
  IREPS_IC_LINK_NOT_FOUND: {
    title: "IC copy link not found",
    message: "IREPS did not provide a \"View/ Download IC PDF\" link for this Inspection Certificate ({detail}).",
    connection: "connected"
  },
  IREPS_IC_DOWNLOAD_FAILED: {
    title: "IC copy download failed",
    message: "DocLink could not download the Inspection Certificate PDF from IREPS ({detail}).",
    connection: "connected"
  },
  IREPS_IC_INVALID_PDF: {
    title: "IC copy not valid",
    message: "IREPS did not return a PDF for this Inspection Certificate ({detail}). Nothing was saved.",
    connection: "connected"
  },
  IC_SESSION_EXPIRED_DURING_DOWNLOAD: {
    title: "IREPS session expired",
    message: "Your IREPS session has expired.\n\nPlease log in again and retry the IC download.",
    connection: "login"
  },
  IREPS_NOTIFICATIONS_FAILED: {
    title: "Unable to load IREPS notifications",
    message: "DocLink could not read the notifications on the IREPS main page ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  IREPS_NOTIFICATIONS_INVALID: {
    title: "Unable to read IREPS notifications",
    message: "IREPS returned a notification list that DocLink could not read ({detail}).",
    connection: "connected"
  },
  BATCH_BUSY: {
    title: "Download Already Running",
    message: "Please wait for the current download to finish."
  },
  IC_BUSY: {
    title: "IC Download Already Running",
    message: "Please wait for the current Inspection Certificate download to finish."
  },
  /* --------------------------------------- Bill upload (services/bill-upload/) */
  BILL_REQUEST_FAILED: {
    title: "IREPS did not answer",
    message: "DocLink could not complete the bill request to IREPS ({detail}). Check your network connection and try again.",
    connection: "offline"
  },
  BILL_FORM_INVALID: {
    title: "IREPS bill page not recognised",
    message: "IREPS did not return the supplier bill page for this receipt ({detail}). Open the receipt's Bill Claim in IREPS to see why.",
    connection: "connected"
  },
  BILL_IREPS_REJECTED: {
    title: "IREPS refused the bill",
    message: "IREPS answered: {detail}",
    connection: "connected"
  },
  BILL_RESPONSE_INVALID: {
    title: "Unexpected IREPS answer",
    message: "IREPS answered in a form DocLink does not recognise ({detail}). Nothing further was sent.",
    connection: "connected"
  },
  BILL_NO_RECEIPTS: {
    title: "No receipts found",
    message: "{detail}.",
    notice: true,
    connection: "connected"
  },
  BILL_NOT_BILLABLE: {
    title: "This receipt cannot be billed",
    message: "{detail}.",
    notice: true,
    connection: "connected"
  },
  BILL_DRAFT_EXISTS: {
    title: "Bill already created",
    message: "{detail}. DocLink does not create a second bill for the same receipt; finish or delete it in IREPS (Bills for Pay), or use \"Start fresh for this receipt\" to create a new one.",
    connection: "connected"
  },
  BILL_CHECKS_FAILED: {
    title: "Checks did not pass",
    message: "Nothing was sent to IREPS: {detail}",
    notice: true,
    connection: "connected"
  },
  BILL_INVOICE_INVALID: {
    title: "Invoice details incomplete",
    message: "{detail}",
    notice: true
  },
  BILL_ECM_NOT_FOUND: {
    title: "Invoice not found in ECM",
    message: "{detail}. ECM does not store the customer PO Sr no. yet, so the match can fail; you can enter the invoice details by hand.",
    notice: true
  },
  BILL_ECM_AMBIGUOUS: {
    title: "More than one ECM invoice",
    message: "{detail}. The spec says to stop when several invoices match.",
    notice: true
  },
  BILL_ECM_ALREADY_SENT: {
    title: "Invoice already sent",
    message: "{detail}.",
    notice: true
  },
  BILL_ECM_UNAVAILABLE: {
    title: "ECM not available",
    message: "DocLink could not read the ECM ({detail})."
  },
  BILL_FILE_INVALID: {
    title: "Invoice file not usable",
    message: "{detail}. Nothing was sent to IREPS.",
    notice: true
  },
  BILL_FILE_NO_MATCH: {
    title: "No invoice for this receipt",
    message: "{detail}. The file's customerPONumber, customerPOSrNumber and quantity must match the receipt.",
    notice: true
  },
  BILL_FILE_AMBIGUOUS: {
    title: "More than one invoice in the file",
    message: "{detail}. Keep one invoice per receipt in the file.",
    notice: true
  },
  BILL_NO_DOCUMENTS: {
    title: "No documents in ECM",
    message: "{detail}",
    notice: true
  },
  BILL_TAB_UNAVAILABLE: {
    title: "IREPS tab needed",
    message: "DocLink sends the bill from your IREPS tab: {detail}.",
    connection: "connected"
  },
  BILL_BUSY: {
    title: "Bill upload busy",
    message: "Please wait for the current bill step to finish."
  },
  BILL_INTERRUPTED: {
    title: "Bill step interrupted",
    message: "Chrome stopped DocLink's background work during this step ({detail}), so it may not have finished. Before you repeat it, check the bill in IREPS (the PO's Bills for Pay tab), so that no second draft bill is created."
  },
  BILL_NOT_PREPARED: {
    title: "Bill not prepared",
    message: "{detail}. Start again from the receipt."
  },
  BILL_DOC_INVALID: {
    title: "Document not usable",
    message: "{detail}. Nothing was sent to IREPS.",
    notice: true
  },
  BILL_SIGNER_UNAVAILABLE: {
    title: "IREPS signer not reachable",
    message: "DocLink could not reach the IREPS signing app (eMudhra IREPSSigner) on this computer: {detail}. Start the signer, reload the IREPS tab and try again. Nothing was uploaded.",
    connection: "connected"
  },
  BILL_SIGN_FAILED: {
    title: "Document not signed",
    message: "{detail}. Nothing was uploaded.",
    notice: true,
    connection: "connected"
  },
  NO_BACKGROUND_RESPONSE: {
    title: "DocLink Needs a Reload",
    message: "DocLink's background service did not answer ({detail}). Open chrome://extensions, click the reload icon on the DocLink card, then retry."
  },
  JOB_INTERRUPTED: {
    title: "Download interrupted",
    message: "Chrome stopped DocLink's background work while this run was in progress ({detail}), so it did not finish. Start it again: the files already saved are kept, and the download log recognises them."
  },
  /* ------------------------------------- Scheduled downloads (Phase 1) */
  SCHEDULE_BACKEND_UNAVAILABLE: {
    title: "Scheduled downloads: Recon Engine unavailable",
    message: "DocLink could not reach the Recon Engine's schedules ({detail}), so no scheduled download runs from this browser. Manual downloads work as usual."
  },
  SCHEDULE_NO_PERMISSION: {
    title: "Scheduled downloads not allowed",
    message: "Your Recon Engine role does not allow scheduled downloads ({detail}). Ask an admin for the doclink.schedule.run permission. Manual downloads work as usual."
  },
  SCHEDULE_INVALID: {
    title: "Schedule not saved",
    message: "The Recon Engine refused the schedule: {detail}."
  },
  SCHEDULE_EXISTS: {
    title: "Schedule already exists",
    message: "This IREPS account already has a schedule for that document type ({detail}). Change the existing one instead."
  },
  SCHEDULE_NOT_FOUND: {
    title: "Schedule not found",
    message: "That schedule no longer exists in the Recon Engine ({detail}). Refresh the view."
  },
  SCHEDULE_SLOT_NOT_FOUND: {
    title: "Scheduled download not found",
    message: "The scheduled download no longer exists ({detail})."
  },
  SCHEDULE_WRONG_ACCOUNT: {
    title: "Scheduled download belongs to another account",
    message: "That scheduled download is for another IREPS account ({detail})."
  },
  SCHEDULE_NOT_DUE: {
    title: "Scheduled download not due",
    message: "That scheduled download is outside its time window or waits for its next check ({detail})."
  },
  SCHEDULE_SLOT_DONE: {
    title: "Already downloaded",
    message: "This scheduled download already ran for this IREPS account ({detail}). It runs again at its next scheduled time: the next hour for hourly downloads, tomorrow for daily ones."
  },
  SCHEDULE_SLOT_TAKEN: {
    title: "Another DocLink user is downloading",
    message: "Another DocLink user is running this scheduled download now ({detail}). Nothing is downloaded twice."
  },
  SCHEDULE_ACCOUNT_BUSY: {
    title: "Another DocLink user is downloading",
    message: "Another DocLink user is running a scheduled download for this IREPS account now ({detail}). The next one starts when it ends."
  },
  SCHEDULE_CLAIM_LOST: {
    title: "Scheduled download handed over",
    message: "This browser lost its turn for the scheduled download ({detail}), so it stopped; another DocLink user carries on. Documents already saved are kept."
  },
  SCHEDULE_ACCOUNT_MISMATCH: {
    title: "Different IREPS account",
    message: "The scheduled download is for another IREPS account than the one logged in here ({detail}), so this browser did not run it."
  },
  SCHEDULE_ACCOUNT_UNVERIFIED: {
    title: "IREPS account not verified",
    message: "DocLink could not tell which IREPS account is logged in ({detail}), so it runs no scheduled download. Open an IREPS page and log in."
  },
  SCHEDULE_DESTINATION_REFUSED: {
    title: "Not saved to S3 / ECM",
    message: "The document could not be saved to S3 / ECM ({detail}). A scheduled download never saves locally; the next check tries it again."
  },
  SCHEDULE_NOT_RESERVED: {
    title: "Document not reserved",
    message: "The document was not reserved for this scheduled download ({detail}), so it was not saved."
  },
  SCHEDULE_DOWNLOAD_FAILED: {
    title: "Scheduled document not downloaded",
    message: "The document could not be downloaded from IREPS ({detail}). The next check tries it again."
  },
  SCHEDULE_TYPE_NOT_SUPPORTED: {
    title: "Document type not scheduled here",
    message: "This DocLink cannot run that scheduled document type ({detail})."
  },
  SCHEDULE_RUNNER_TIMEOUT: {
    title: "Scheduled tender download took too long",
    message: "The scheduled tender download did not finish in time ({detail}). What it saved is kept; the next check fetches the rest."
  },
  SCHEDULE_RUNNER_CLOSED: {
    title: "Scheduled tender download stopped",
    message: "The DocLink tab running the scheduled tender download was closed ({detail}). What it saved is kept; another DocLink user can run it now."
  },
  SCHEDULE_RUNNER_NOT_OPENED: {
    title: "Scheduled tender download not started",
    message: "DocLink could not open the tab that runs scheduled tender downloads ({detail}). It tries again at the next check."
  },
  SCHEDULE_TENDER_FAILED: {
    title: "Scheduled tender download failed",
    message: "The scheduled tender download stopped with an error ({detail}). The next check tries again."
  },
  SCHEDULE_MISSED: {
    title: "Scheduled download missed",
    message: "No DocLink ran this scheduled download during its time ({detail}). An hourly download catches up in its next run."
  },
  UNKNOWN: {
    title: "Something Went Wrong",
    message: "DocLink could not complete the download ({detail}). Please retry."
  }
});

/**
 * Build the user-facing error payload for a code.
 * @param {string} code
 * @param {{ status?: number|null, detail?: string|null }} [details]
 */
export function describeError(code, details = {}) {
  const entry = ERROR_CATALOG[code] || ERROR_CATALOG.UNKNOWN;
  const detail = details.detail || (details.status ? `IREPS returned HTTP ${details.status}` : "") || "request failed";
  return {
    code: ERROR_CATALOG[code] ? code : "UNKNOWN",
    title: entry.title,
    // a function, so "$&" or "$1" in an IREPS / server text is kept as written, not expanded
    message: entry.message.replace("{detail}", () => detail),
    loginRequired: entry.loginRequired === true,
    previewAvailable: entry.previewAvailable === true,
    notice: entry.notice === true,
    reconSignIn: entry.reconSignIn === true,
    connection: entry.connection || null
  };
}

/**
 * An error as the panel shows it: an already described error (it has a title) as it is,
 * otherwise a { code, detail, status } error (or nothing) through describeError.
 */
export function asDescribedError(error, fallbackCode = "UNKNOWN") {
  if (error && error.title) return error;
  return describeError((error && error.code) || fallbackCode, { detail: error && error.detail, status: error && error.status });
}

/** chrome.storage.local keys (non-sensitive metadata only). */
export const STORAGE_KEYS = Object.freeze({
  LAST_DOWNLOAD: "doclink.lastDownload",
  LAST_CRN_DOWNLOAD: "doclink.lastCrnDownload",
  LAST_RNOTE_DOWNLOAD: "doclink.lastRnoteDownload",
  LAST_MA_DOWNLOAD: "doclink.lastMaDownload",
  LAST_PO_DOWNLOAD: "doclink.lastPoDownload",
  LAST_IC_DOWNLOAD: "doclink.lastIcDownload",
  // the panel-wide Save to switch: "local" | "recon" (shown as "ECM / S3": IC, PO, MA and
  // tender documents go to the ECM, Bill Status, CRN and R-NOTE to the Recon Engine's S3)
  SAVE_DESTINATION: "doclink.saveDestination",
  // scheduled downloads: the last verified IREPS account id ({ id, at }), never page content
  SCHEDULER_ACCOUNT: "doclink.scheduler.account",
  // scheduled downloads: this browser's run log ({ runs, events }: document numbers, codes, reasons)
  SCHEDULER_RUN_LOG: "doclink.scheduler.runLog"
});

/** chrome.storage.session keys (memory only, cleared when Chrome closes). */
export const SESSION_KEYS = Object.freeze({
  JOB_STATE: "doclink.jobState",
  LAST_RESULT: "doclink.lastBillStatusResult",
  DOCUMENT_JOBS: "doclink.documentJobs",
  MA_STATE: "doclink.maState",
  PO_STATE: "doclink.poState",
  IC_STATE: "doclink.icState",
  BATCH_STATE: "doclink.batchState",
  BILL_UPLOAD_STATE: "doclink.billUploadState",
  // scheduled downloads: when IREPS was last active / the IREPS check last failed in this browser
  SCHEDULER_SIGNALS: "doclink.scheduler.signals"
});
