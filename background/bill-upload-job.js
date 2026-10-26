/**
 * Service-worker side of the bill upload (services/bill-upload/): one job at a time, its
 * state kept in memory and in chrome.storage.session (so a restarted worker or a reopened
 * panel shows where it stopped), every change broadcast to the panel as BILL_UPLOAD_UPDATE.
 *
 *   BILL_UPLOAD_SEARCH     { poNo }                          -> receipts      (R-NOTE + CRN search)
 *   BILL_UPLOAD_PREPARE    { receiptKey, invoiceMode, manualInvoice, overrides } -> review (ECM / typed invoice + read-only IREPS calls)
 *   BILL_UPLOAD_REVIEW     { overrides }                     -> review        (re-checked)
 *   BILL_UPLOAD_CREATE     { confirmed, acknowledged }       -> done | item-review | item-blocked   WRITES the draft bill
 *   BILL_UPLOAD_SAVE_ITEM  { acknowledged }                  -> done | item-review | item-blocked   WRITES the item
 *   BILL_UPLOAD_DOCUMENTS  {}                                -> documents saved locally
 *   BILL_UPLOAD_GET_STATE / BILL_UPLOAD_RESET
 *
 * Each action answers { started: true } at once and finishes in the background; the panel
 * follows BILL_UPLOAD_UPDATE. IREPS bill calls run in the panel's IREPS tab (tab-transport.js).
 */

import { MESSAGE_TYPES, SESSION_KEYS, describeError } from "../utils/messages.js";
import { IrepsError } from "../services/ireps-api.js";
import { logger } from "../utils/logger.js";
import { BILL_ERROR } from "../services/bill-upload/bill-upload-api.js";
import { findBillableReceipts, prepareBill, reviewBill, createDraftBill, saveItem, collectBillDocuments, billDocumentTypes } from "../services/bill-upload/bill-upload-service.js";
import { retrieveInvoice, manualInvoice } from "../services/bill-upload/ecm-invoice.js";
import { createBillStore } from "../services/bill-upload/bill-upload-store.js";
import { tabFetch, assertIrepsTab } from "../services/bill-upload/tab-transport.js";
import { searchRnote } from "../services/rnote/rnote-service.js";
import { searchCrn } from "../services/crn/crn-service.js";
import { downloadBytes } from "../services/download-service.js";

const IDLE = Object.freeze({ step: "idle", busy: false, message: "", poNo: "", receipts: [], warnings: [], receiptKey: null, invoiceMode: "ecm", invoice: null, context: null, documents: null, error: null });

/**
 * @param {{ broadcast: (type: string, payload: object) => void, parseSearchPo: (html: string, options: object) => Promise<object> }} hooks
 */
export function createBillUploadJob({ broadcast, parseSearchPo }) {
  let state = { ...IDLE, updatedAt: Date.now() };
  let restored = false;
  const store = createBillStore();

  async function restore() {
    if (restored) return;
    restored = true;
    try {
      const got = await chrome.storage.session.get(SESSION_KEYS.BILL_UPLOAD_STATE);
      const saved = got && got[SESSION_KEYS.BILL_UPLOAD_STATE];
      // a worker that died mid-step is not busy any more
      if (saved && state.step === "idle") state = { ...saved, busy: false };
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
            documentsOnBill: c.documentsOnBill || null
          }
        : null,
      documents: state.documents,
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
    (async () => {
      await set({ busy: true, message, error: null });
      try {
        const patch = await work();
        await set({ busy: false, message: "", ...patch });
      } catch (error) {
        const info = described(error);
        if (!(error instanceof IrepsError)) logger.error(`Bill upload step ${step} failed`, error);
        else logger.warn(`Bill upload step ${step} stopped: ${info.title}`, { code: error.code, detail: error.detail });
        // a failure after the draft bill was created keeps that bill on screen
        if (error && error.billRegNo && error.context) await set({ busy: false, message: "", step: "item-error", context: error.context, error: info });
        else await set({ busy: false, message: "", step: before, error: info });
      }
    })();
    return { started: true };
  }

  function irepsDeps(panelTabId) {
    return { fetch: tabFetch(panelTabId), store };
  }

  const searchDeps = {
    searchRnote: (options) => searchRnote(options, { parseHtml: (html, o) => parseSearchPo(html, { ...o, criteria: "RNOTE" }) }),
    searchCrn: (options) => searchCrn(options, { parseHtml: (html, o) => parseSearchPo(html, { ...o, criteria: "CRN" }) })
  };

  function requireInvoiceFields(invoice) {
    const missing = [];
    if (!invoice.invoiceNumber) missing.push("invoice number");
    if (!invoice.invoiceDate) missing.push("invoice date");
    if (!invoice.amount) missing.push("invoice amount");
    if (!invoice.hsn) missing.push("HSN code");
    if (missing.length) throw new IrepsError(BILL_ERROR.INVOICE_INVALID, "manual invoice incomplete", { detail: `Enter the ${missing.join(", ")}.` });
  }

  return {
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
      const invoiceMode = msg.invoiceMode === "manual" ? "manual" : "ecm";
      return run("prepare", invoiceMode === "ecm" ? "Finding the invoice in ECM and reading the bill page in IREPS..." : "Reading the bill page in IREPS...", async () => {
        await assertIrepsTab(msg.panelTabId);
        let invoice;
        if (invoiceMode === "manual") {
          invoice = manualInvoice(msg.manualInvoice || {});
          requireInvoiceFields(invoice);
        } else {
          invoice = await retrieveInvoice({ customerPO: receipt.poNo, customerPOSrNo: receipt.poSr, invoiceQuantity: Number.isFinite(receipt.qty) ? receipt.qty : receipt.qtyText });
        }
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
}
