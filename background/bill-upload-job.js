/**
 * Service-worker side of the bill upload (services/bill-upload/): one job at a time, its
 * state kept in memory and in chrome.storage.session (so a restarted worker or a reopened
 * panel shows where it stopped), every change broadcast to the panel as BILL_UPLOAD_UPDATE.
 *
 *   BILL_UPLOAD_SEARCH     { poNo }                          -> receipts      (R-NOTE + CRN search)
 *   BILL_UPLOAD_PREPARE    { receiptKey, invoiceMode, manualInvoice, invoiceFile, overrides } -> review
 *                          (invoice from ECM / a picked JSON file / typed, + read-only IREPS calls)
 *   BILL_UPLOAD_REVIEW     { overrides }                     -> review        (re-checked)
 *   BILL_UPLOAD_CREATE     { confirmed, acknowledged }       -> done | item-review | item-blocked   WRITES the draft bill
 *   BILL_UPLOAD_SAVE_ITEM  { acknowledged }                  -> done | item-review | item-blocked   WRITES the item
 *   BILL_UPLOAD_DOCUMENTS  {}                                -> documents saved locally
 *   BILL_UPLOAD_ADD_DOCUMENT { file: { name, base64 }, fileDesc } -> signed in the IREPS signer, uploaded to the bill   WRITES
 *   BILL_UPLOAD_FORGET     {}                                -> review        (forgets DocLink's record of an earlier bill)
 *   BILL_UPLOAD_CONFIRM_CHECKED { step, at, checked }        -> the user checked the bill in IREPS after a
 *                          write's answer did not arrive; DocLink may send that step again (review 3.1)
 *   BILL_UPLOAD_GET_STATE / BILL_UPLOAD_RESET
 *
 * Each action answers { started: true } at once and finishes in the background; the panel
 * follows BILL_UPLOAD_UPDATE. IREPS bill calls run in the panel's IREPS tab (tab-transport.js).
 */

import { MESSAGE_TYPES, SESSION_KEYS, describeError } from "../utils/messages.js";
import { IrepsError } from "../services/ireps-api.js";
import { logger } from "../utils/logger.js";
import { BILL_ERROR } from "../services/bill-upload/bill-upload-api.js";
import {
  findBillableReceipts,
  invoiceForReceipt,
  prepareBill,
  reviewBill,
  forgetBill,
  createDraftBill,
  saveItem,
  addDocumentToBill,
  confirmCheckedInIreps,
  withStoredBill,
  unknownOutcome,
  collectBillDocuments,
  billDocumentTypes
} from "../services/bill-upload/bill-upload-service.js";
import { MAX_INVOICE_FILE_RECORDS } from "../services/bill-upload/invoice-file.js";
import { createBillStore } from "../services/bill-upload/bill-upload-store.js";
import { tabFetch, tabSignPdf, tabSaveFile, assertIrepsTab } from "../services/bill-upload/tab-transport.js";
import { MAX_SIGN_BYTES } from "../services/bill-upload/bill-document-upload.js";
import { searchRnote } from "../services/rnote/rnote-service.js";
import { searchCrn } from "../services/crn/crn-service.js";
import { downloadBytes } from "../services/download-service.js";
import { holdWorker } from "./keep-alive.js";

const IDLE = Object.freeze({ step: "idle", busy: false, running: null, message: "", poNo: "", receipts: [], warnings: [], receiptKey: null, invoiceMode: "ecm", invoice: null, context: null, documents: null, docUpload: null, error: null });

const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What a step that Chrome cut off was doing, and what to check before it is repeated
 * (BILL_INTERRUPTED, review 3.13a): a write may have reached IREPS, a read never wrote anything.
 */
function interruptedDetail(saved) {
  const c = saved.context || {};
  const bill = c.billRegNo || (c.existing && c.existing.billRegNo) || "?";
  const invoice = (c.invoice && c.invoice.invoiceNumber) || (saved.invoice && saved.invoice.invoiceNumber) || "?";
  const po = c.receipt ? ` (PO ${c.receipt.poNo}, PO Sr ${c.receipt.poSr})` : "";
  switch (saved.running) {
    case "create":
      return `creating the draft bill for invoice ${invoice}${po}. IREPS may have created it: look for it on the PO's Bills for Pay tab in IREPS before you create it again`;
    case "item":
      return `saving the item of draft bill ${bill}. IREPS may have saved it: check bill ${bill} in IREPS (the PO's Bills for Pay tab) before you save the item again`;
    case "add-document":
      return `uploading a document to draft bill ${bill}. IREPS may have added it: check the bill's documents in IREPS before you upload it again`;
    case "search":
      return "searching the R-Notes and CRNs. That step only reads IREPS: search again";
    case "prepare":
      return "preparing the bill. That step only reads IREPS and ECM: prepare it again";
    case "review":
      return "checking your changes. That step only reads IREPS: apply them again";
    case "documents":
      return "getting the documents from ECM. Nothing was sent to IREPS: get them again";
    default:
      return `${lower(saved.message || "running a bill step")} Check the bill in IREPS (the PO's Bills for Pay tab) before you repeat it`;
  }
}

/** The error's causes, for the log (logger.js redacts them): what the transport really said. */
function causeChain(error) {
  const parts = [];
  for (let e = error && error.cause, i = 0; e && i < 5; e = e.cause, i++) parts.push(`${e.code || e.name || "Error"}: ${e.message || e}`);
  return parts.length ? parts.join(" <- ") : null;
}

/**
 * @param {{ broadcast: (type: string, payload: object) => void, parseSearchPo: (html: string, options: object) => Promise<object> }} hooks
 */
/**
 * @param {{ broadcast: Function, parseSearchPo: Function, onJobEnded?: () => void }} deps
 *   onJobEnded: called when each step ends (done or failed), so that a scheduled download that waited for it may run
 */
export function createBillUploadJob({ broadcast, parseSearchPo, onJobEnded = () => {} }) {
  let state = { ...IDLE, updatedAt: Date.now() };
  let restored = false;
  const store = createBillStore();

  async function restore() {
    if (restored) return;
    restored = true;
    try {
      const got = await chrome.storage.session.get(SESSION_KEYS.BILL_UPLOAD_STATE);
      const saved = got && got[SESSION_KEYS.BILL_UPLOAD_STATE];
      // a worker that died mid-step is not busy any more; say which step was cut off (a write may
      // or may not have reached IREPS, so the user checks there before doing it again)
      if (saved && state.step === "idle") {
        state = saved.busy
          ? { ...saved, busy: false, running: null, message: "", error: describeError("BILL_INTERRUPTED", { detail: interruptedDetail(saved) }) }
          : { ...saved, busy: false, running: null };
        // a write that was under way is recorded in the bill store: show its stop at once
        if (state.context && state.context.receipt) state = { ...state, context: await withStoredBill(state.context, { store }) };
      }
    } catch (error) {
      logger.debug("Could not restore the bill upload state", error);
    }
  }

  async function set(patch) {
    state = { ...state, ...patch, updatedAt: Date.now() };
    try {
      await chrome.storage.session.set({ [SESSION_KEYS.BILL_UPLOAD_STATE]: state });
    } catch (error) {
      logger.debug("Could not persist the bill upload state", error);
    }
    broadcast(MESSAGE_TYPES.BILL_UPLOAD_UPDATE, { state: publicState() });
  }

  /** What the panel needs; the IREPS page values (bank details, form literals) stay here. */
  function publicState() {
    const c = state.context;
    return {
      step: state.step,
      busy: state.busy,
      message: state.message,
      poNo: state.poNo,
      receipts: state.receipts,
      warnings: state.warnings,
      receiptKey: state.receiptKey,
      invoiceMode: state.invoiceMode,
      invoice: state.invoice,
      bill: c
        ? {
            receipt: c.receipt,
            header: c.header ? { review: c.header.review, checks: c.header.checks } : null,
            item: c.item || null,
            billRegNo: c.billRegNo || (c.existing && c.existing.billRegNo) || null,
            dispatchNo: c.dispatchNo || (c.existing && c.existing.dispatchNo) || null,
            existing: c.existing || null,
            // a write whose answer did not arrive: what to check in IREPS and confirm (review 3.1)
            unknown: unknownOutcome(c.existing),
            documentsOnBill: c.documentsOnBill || null,
            forgottenBills: c.forgottenBills || []
          }
        : null,
      documents: state.documents,
      docUpload: state.docUpload || null,
      documentTypes: billDocumentTypes(),
      error: state.error,
      updatedAt: state.updatedAt
    };
  }

  function described(error) {
    if (error instanceof IrepsError) return describeError(error.code, { status: error.status, detail: error.detail });
    logger.error("Bill upload failed", error);
    return describeError("UNKNOWN", { detail: (error && error.message) || String(error) });
  }

  /** Run one step in the background; `work` returns the state patch of its success. */
  function run(step, message, work) {
    if (state.busy) return { started: false, error: describeError(BILL_ERROR.BUSY) };
    const before = state.step;
    holdWorker(async () => {
      await set({ busy: true, running: step, message, error: null });
      try {
        const patch = await work();
        await set({ busy: false, running: null, message: "", ...patch });
      } catch (error) {
        const info = described(error);
        if (!(error instanceof IrepsError)) logger.error(`Bill upload step ${step} failed`, error);
        else logger.warn(`Bill upload step ${step} stopped: ${info.title}`, { code: error.code, detail: error.detail, cause: causeChain(error) });
        // a failure after the draft bill was created keeps that bill on screen; one that changed what
        // is known about the bill (a write whose answer is missing) shows that
        if (error && error.billRegNo && error.context) await set({ busy: false, running: null, message: "", step: "item-error", context: error.context, error: info });
        else if (error && error.context) await set({ busy: false, running: null, message: "", step: before, context: error.context, error: info });
        else await set({ busy: false, running: null, message: "", step: before, error: info });
      } finally {
        try {
          onJobEnded();
        } catch (error) {
          logger.debug("Bill upload: the job-ended hook failed", error);
        }
      }
    });
    return { started: true };
  }

  function irepsDeps(panelTabId) {
    return { fetch: tabFetch(panelTabId), store };
  }

  const searchDeps = {
    searchRnote: (options) => searchRnote(options, { parseHtml: (html, o) => parseSearchPo(html, { ...o, criteria: "RNOTE" }) }),
    searchCrn: (options) => searchCrn(options, { parseHtml: (html, o) => parseSearchPo(html, { ...o, criteria: "CRN" }) })
  };

  const handlers = {
    [MESSAGE_TYPES.BILL_UPLOAD_GET_STATE]: async () => {
      await restore();
      return publicState();
    },

    [MESSAGE_TYPES.BILL_UPLOAD_RESET]: async () => {
      await restore();
      if (state.busy) return { ok: false, error: describeError(BILL_ERROR.BUSY) };
      await set({ ...IDLE });
      return { ok: true };
    },

    [MESSAGE_TYPES.BILL_UPLOAD_SEARCH]: async (msg) => {
      await restore();
      const poNo = typeof msg.poNo === "string" ? msg.poNo.trim() : "";
      return run("search", poNo ? `Searching R-Notes and CRNs of PO ${poNo}...` : "Searching R-Notes and CRNs of the last 180 days...", async () => {
        const found = await findBillableReceipts({ poNo }, searchDeps);
        logger.info(`Bill upload: ${found.receipts.length} receipts (${found.receipts.filter((r) => r.billable).length} billable)`, { poNo });
        return { ...IDLE, step: "receipts", poNo, receipts: found.receipts, warnings: found.warnings };
      });
    },

    [MESSAGE_TYPES.BILL_UPLOAD_PREPARE]: async (msg) => {
      await restore();
      const receipt = state.receipts.find((r) => r.key === msg.receiptKey);
      if (!receipt) return { started: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "That receipt is no longer listed" }) };
      const invoiceMode = ["manual", "file"].includes(msg.invoiceMode) ? msg.invoiceMode : "ecm";
      const file = msg.invoiceFile;
      if (invoiceMode === "file" && !(file && typeof file.name === "string" && Array.isArray(file.records) && file.records.length && file.records.length <= MAX_INVOICE_FILE_RECORDS)) {
        return { started: false, error: describeError(BILL_ERROR.FILE_INVALID, { detail: "Choose the JSON file first" }) };
      }
      return run("prepare", invoiceMode === "ecm" ? "Finding the invoice in ECM and reading the bill page in IREPS..." : "Reading the bill page in IREPS...", async () => {
        await assertIrepsTab(msg.panelTabId);
        const invoice = await invoiceForReceipt({ receipt, mode: invoiceMode, fields: msg.manualInvoice || {}, file: invoiceMode === "file" ? { name: file.name, records: file.records } : null });
        if (invoiceMode === "file") logger.info("Bill upload: invoice from JSON file", { file: file.name, invoice: invoice.invoiceNumber, po: receipt.poNo, poSr: receipt.poSr });
        const context = await prepareBill({ receipt, invoice, overrides: msg.overrides || {} }, irepsDeps(msg.panelTabId));
        return { step: "review", receiptKey: receipt.key, invoiceMode, invoice, context, documents: null };
      });
    },

    [MESSAGE_TYPES.BILL_UPLOAD_REVIEW]: async (msg) => {
      await restore();
      if (!state.context || state.step !== "review") return { started: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "Prepare the bill first" }) };
      return run("review", "Checking your changes...", async () => {
        await assertIrepsTab(msg.panelTabId);
        return { step: "review", context: await reviewBill(state.context, msg.overrides || {}, irepsDeps(msg.panelTabId)) };
      });
    },

    // "Start fresh": DocLink already created a bill for this receipt (an earlier try) and the
    // user wants to create a new one. Only DocLink's record is dropped; IREPS is not touched,
    // so the old bill's number stays on screen (bill.forgottenBills) for the user to delete it there.
    [MESSAGE_TYPES.BILL_UPLOAD_FORGET]: async () => {
      await restore();
      if (state.busy) return { ok: false, error: describeError(BILL_ERROR.BUSY) };
      if (!state.context || state.step !== "review") return { ok: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "Prepare the bill first" }) };
      let context;
      try {
        ({ context } = await forgetBill(state.context, { store }));
      } catch (error) {
        // a header whose creation IREPS has not confirmed is cleared only by "I checked in IREPS"
        if (error && error.context) await set({ context: error.context });
        return { ok: false, error: described(error) };
      }
      await set({ step: "review", context, documents: null, error: null });
      return { ok: true };
    },

    // After a write whose answer did not arrive: the user checked the bill in IREPS and confirms it,
    // so DocLink may send that step again. Only DocLink's record changes; IREPS is not touched.
    [MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED]: async (msg) => {
      await restore();
      if (state.busy) return { ok: false, error: describeError(BILL_ERROR.BUSY) };
      if (!state.context || !state.context.receipt) return { ok: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "Prepare the bill first" }) };
      if (msg.checked !== true) return { ok: false, error: describeError(BILL_ERROR.CHECKS_FAILED, { detail: "tick that you checked the bill in IREPS first" }) };
      try {
        const context = await confirmCheckedInIreps(state.context, { step: msg.step, at: msg.at }, { store });
        await set({ context, error: null });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: described(error) };
      }
    },

    [MESSAGE_TYPES.BILL_UPLOAD_CREATE]: async (msg) => {
      await restore();
      if (!state.context || state.step !== "review") return { started: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "Prepare the bill first" }) };
      if (msg.confirmed !== true) return { started: false, error: describeError(BILL_ERROR.CHECKS_FAILED, { detail: "confirm that the values are right first" }) };
      return run("create", "Creating the draft bill in IREPS...", async () => {
        await assertIrepsTab(msg.panelTabId);
        const { outcome, context } = await createDraftBill(state.context, { acknowledged: msg.acknowledged === true }, irepsDeps(msg.panelTabId));
        return { step: outcome === "item-saved" ? "done" : outcome, context };
      });
    },

    [MESSAGE_TYPES.BILL_UPLOAD_SAVE_ITEM]: async (msg) => {
      await restore();
      if (!state.context || !state.context.billRegNo || !["item-review", "item-error"].includes(state.step)) {
        return { started: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "There is no saved bill header waiting for its item" }) };
      }
      return run("item", "Saving the bill item in IREPS...", async () => {
        await assertIrepsTab(msg.panelTabId);
        const { outcome, context } = await saveItem(state.context, { acknowledged: msg.acknowledged === true }, irepsDeps(msg.panelTabId));
        return { step: outcome === "item-saved" ? "done" : outcome, context };
      });
    },

    // One PDF onto the draft bill: signed by the user in the IREPS signer, stored and registered
    // in IREPS (services/bill-upload/bill-document-upload.js).
    [MESSAGE_TYPES.BILL_UPLOAD_ADD_DOCUMENT]: async (msg) => {
      await restore();
      const c = state.context;
      const billRegNo = c && (c.billRegNo || (c.existing && c.existing.billRegNo));
      const dispatchNo = c && (c.dispatchNo || (c.existing && c.existing.dispatchNo));
      if (!c || !billRegNo || !dispatchNo) {
        return { started: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "Documents can be added once the bill item is saved (IREPS needs the dispatch no.)" }) };
      }
      const file = msg.file;
      if (!(file && typeof file.name === "string" && typeof file.base64 === "string" && file.base64.length && file.base64.length < (MAX_SIGN_BYTES * 4) / 3 + 8)) {
        return { started: false, error: describeError(BILL_ERROR.DOC_INVALID, { detail: "Choose a PDF below 8 MB first" }) };
      }
      const fileDesc = typeof msg.fileDesc === "string" ? msg.fileDesc : "";
      const step = state.step;
      return run("add-document", `Sign ${file.name} in the IREPS signer window (select your DSC, enter the PIN); DocLink then uploads it to bill ${billRegNo}...`, async () => {
        await assertIrepsTab(msg.panelTabId);
        const bill = { billRegNo, dispatchNo, vendorCode: c.form.literals.vendorCode, thumbprint: c.form.certThumbprint, spmBillRegNo: c.form.literals.spmBillRegNo };
        const result = await addDocumentToBill(
          state.context,
          { bill, file, fileDesc },
          { store, fetch: tabFetch(msg.panelTabId), signPdf: tabSignPdf(msg.panelTabId), saveFile: tabSaveFile(msg.panelTabId) }
        );
        logger.info(`Bill upload: document uploaded to bill ${billRegNo}`, { file: result.fileName, desc: fileDesc, documents: result.documents.length });
        return { step, context: { ...state.context, documentsOnBill: result.documents }, docUpload: { fileName: result.fileName, fileDesc: fileDesc.trim(), billRegNo, at: new Date().toISOString() } };
      });
    },

    [MESSAGE_TYPES.BILL_UPLOAD_DOCUMENTS]: async () => {
      await restore();
      if (!state.context) return { started: false, error: describeError(BILL_ERROR.NOT_PREPARED, { detail: "Prepare the bill first" }) };
      const step = state.step;
      return run("documents", "Fetching the invoice documents from ECM...", async () => {
        const c = state.context;
        const result = await collectBillDocuments(
          { invoice: c.invoice, receipt: c.receipt, inspectionAgency: (c.item && c.item.inspectionAgency) || null },
          { saveFile: (bytes, path) => downloadBytes(bytes, { path, mimeType: "application/pdf" }) }
        );
        // the per-document rows stay on screen either way; "none usable" is reported as well
        const none = !result.documents.some((d) => d.status === "saved");
        return { step, documents: result, error: none ? describeError(BILL_ERROR.NO_DOCUMENTS, { detail: `ECM has no usable document for invoice ${c.invoice.invoiceNumber} / PO ${c.receipt.poNo}.` }) : null };
      });
    }
  };
  // not a message handler (non-enumerable, so `...billUploadJob` leaves it out): the scheduler
  // starts no scheduled download while a bill step is running
  Object.defineProperty(handlers, "isBusy", { value: () => state.busy === true });
  return handlers;
}
