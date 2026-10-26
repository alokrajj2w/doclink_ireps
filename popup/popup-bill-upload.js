/**
 * Bill upload view of the DocLink panel ("Upload Bill to IREPS"): a thin view over the
 * service worker's bill upload job (background/bill-upload-job.js). Every button sends one
 * BILL_UPLOAD_* request; the job answers { started } and reports progress and results as
 * BILL_UPLOAD_UPDATE with its whole public state, which render() draws:
 *
 *   1. Receipt   PO number -> R-NOTE / CRN receipts, billable ones selectable
 *   2. Invoice   from ECM, or typed by hand
 *   3. Header    every value with its source, editable where DocLink can only derive it,
 *                the checks; "Create draft bill" only with no errors, warnings read and the
 *                values confirmed
 *   4. Bill      bill reg no., the item values and checks; "Save item details" when the item
 *                waits for the user
 *   5. Documents the invoice's ECM documents saved locally with the IREPS description to type,
 *                and the steps left in IREPS
 *
 * Built with textContent only; nothing from IREPS or ECM is inserted as HTML.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";

const $ = (id) => document.getElementById(id);

let ctx = null;
let state = null;
const el = {};

function bindElements() {
  Object.assign(el, {
    view: $("view-upload"),
    btnOpen: $("btn-upload"),
    btnBack: $("btn-bill-back"),
    po: $("bill-po"),
    btnSearch: $("btn-bill-search"),
    receipts: $("bill-receipts"),
    receiptWarnings: $("bill-receipt-warnings"),
    stepInvoice: $("bill-step-invoice"),
    modeRadios: Array.from(document.querySelectorAll('input[name="bill-invoice-mode"]')),
    manual: $("bill-manual"),
    invNumber: $("bill-inv-number"),
    invDate: $("bill-inv-date"),
    invAmount: $("bill-inv-amount"),
    invQty: $("bill-inv-qty"),
    invHsn: $("bill-inv-hsn"),
    invDivision: $("bill-inv-division"),
    invPlace: $("bill-inv-place"),
    btnPrepare: $("btn-bill-prepare"),
    stepReview: $("bill-step-review"),
    review: $("bill-review"),
    btnApply: $("btn-bill-apply"),
    checks: $("bill-checks"),
    ackRow: $("bill-ack-row"),
    ack: $("bill-ack"),
    confirm: $("bill-confirm"),
    btnCreate: $("btn-bill-create"),
    stepResult: $("bill-step-result"),
    result: $("bill-result"),
    resultTitle: $("bill-result-title"),
    resultText: $("bill-result-text"),
    itemReview: $("bill-item-review"),
    itemChecks: $("bill-item-checks"),
    itemAckRow: $("bill-item-ack-row"),
    itemAck: $("bill-item-ack"),
    btnSaveItem: $("btn-bill-save-item"),
    stepDocs: $("bill-step-docs"),
    btnDocs: $("btn-bill-docs"),
    docs: $("bill-docs"),
    btnDocsFolder: $("btn-bill-docs-folder"),
    next: $("bill-next"),
    nextSteps: $("bill-next-steps"),
    progress: $("bill-progress"),
    progressMessage: $("bill-progress-message"),
    error: $("bill-error"),
    errorTitle: $("bill-error-title"),
    errorMessage: $("bill-error-message"),
    btnOpenIreps: $("btn-bill-open-ireps"),
    btnReset: $("btn-bill-reset")
  });
}

/** The receipt the user picked (radio), kept across re-renders. */
let selectedKey = null;
/** chrome.downloads id of the first saved document ("Show in folder"). */
let folderDownloadId = null;

async function request(type, payload = {}) {
  const panelTabId = await ctx.currentPanelTabId();
  const response = await ctx.send(type, panelTabId === null ? payload : { ...payload, panelTabId });
  if (!response) {
    renderError(describeError("NO_BACKGROUND_RESPONSE", { detail: "no answer" }));
    return null;
  }
  if (response.started === false || response.ok === false) renderError(response.error);
  return response;
}

/* -------------------------------------------------------------------------- */
/* Rendering helpers                                                          */
/* -------------------------------------------------------------------------- */

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function setBusy(button, busy) {
  button.classList.toggle("is-busy", busy);
}

function renderError(error) {
  if (!error) {
    el.error.hidden = true;
    return;
  }
  const described = error.title ? error : describeError(error.code || "UNKNOWN", error);
  el.errorTitle.textContent = described.title;
  el.errorMessage.textContent = described.message;
  el.error.classList.toggle("is-notice", described.notice === true);
  el.btnOpenIreps.hidden = described.connection !== "login";
  el.error.hidden = false;
  if (described.connection) ctx.setConnectionForError(described);
}

function renderChecks(list, checks) {
  list.replaceChildren();
  for (const c of checks || []) list.append(node("li", `bill-check bill-check-${c.level}`, `${c.level === "error" ? "Stop: " : "Check: "}${c.text}`));
  list.hidden = !(checks && checks.length);
}

/** One review row; editable rows get a select / input carrying data-key. */
function reviewRow(row, editable) {
  const dt = node("dt", null, row.label);
  const dd = node("dd");
  if (editable && row.editable === "select") {
    const select = node("select", "bill-edit");
    select.dataset.key = row.key;
    select.append(new Option("Choose...", ""));
    const current = row.raw !== undefined ? row.raw : row.value;
    for (const o of row.options || []) {
      const option = new Option(row.key === "stateOfSupply" ? `${o.value} ${o.label}` : o.label, o.value);
      if (o.value === current) option.selected = true;
      select.append(option);
    }
    select.dataset.initial = current || "";
    dd.append(select);
  } else if (editable && row.editable === "text") {
    const input = node("input", "bill-edit");
    input.type = "text";
    input.value = row.value || "";
    input.dataset.key = row.key;
    input.dataset.initial = row.value || "";
    if (row.maxLength) input.maxLength = row.maxLength;
    dd.append(input);
  } else {
    dd.append(node("span", "bill-value", row.value || "-"));
  }
  dd.append(node("span", "bill-source", row.source));
  return [dt, dd];
}

function renderReview(dl, rows, editable) {
  dl.replaceChildren();
  for (const row of rows || []) dl.append(...reviewRow(row, editable));
  dl.hidden = !(rows && rows.length);
}

function overridesFromForm() {
  const out = {};
  for (const input of el.review.querySelectorAll(".bill-edit")) {
    if (input.value !== input.dataset.initial) out[input.dataset.key] = input.value;
  }
  return out;
}

const RECEIPT_LABEL = { RNOTE: "R-Note", CRN: "CRN" };

function renderReceipts(s) {
  el.receipts.replaceChildren();
  for (const r of s.receipts) {
    const li = node("li", `bill-item${r.billable ? "" : " is-disabled"}`);
    const label = node("label");
    const radio = node("input");
    radio.type = "radio";
    radio.name = "bill-receipt";
    radio.value = r.key;
    radio.disabled = !r.billable || s.busy || s.step !== "receipts";
    radio.checked = r.key === (s.receiptKey || selectedKey);
    radio.addEventListener("change", () => {
      selectedKey = r.key;
      el.stepInvoice.hidden = false;
    });
    label.append(radio, node("span", "bill-item-title", `${RECEIPT_LABEL[r.source] || r.source} ${r.receiptNo || "-"} - PO ${r.poNo} / ${r.poSr}`));
    label.append(node("span", "bill-item-detail", [r.qtyText, r.receiptDate, r.roNo && r.roNo !== r.receiptNo ? `RO ${r.roNo}` : null, r.railway].filter(Boolean).join(" - ")));
    if (r.reason) label.append(node("span", "bill-item-note", r.reason));
    li.append(label);
    el.receipts.append(li);
  }
  el.receipts.hidden = s.receipts.length === 0;
  el.receiptWarnings.textContent = (s.warnings || []).join(" ");
  el.receiptWarnings.hidden = !(s.warnings && s.warnings.length);
}

const DOC_STATUS = { saved: "saved", missing: "not in ECM", invalid: "not a PDF", "too-large": "too large", failed: "failed" };
const DOC_NEED = { required: "needed", conditional: "needed for some inspections", optional: "if applicable", "not-needed": "not needed for this inspection" };

function renderDocuments(s) {
  const result = s.documents;
  el.docs.replaceChildren();
  folderDownloadId = null;
  if (!result) {
    el.docs.hidden = true;
    el.btnDocsFolder.hidden = true;
    return;
  }
  for (const d of result.documents) {
    const li = node("li", `bill-item bill-doc-${d.status}`);
    li.append(node("span", "bill-item-title", `${d.label} - ${DOC_STATUS[d.status] || d.status} (${DOC_NEED[d.need] || d.need})`));
    if (d.status === "saved") {
      li.append(node("span", "bill-item-detail", `Description to type in IREPS: ${d.fileDesc}`));
      li.append(node("span", "bill-item-detail", `File: ${d.filename}`));
      if (folderDownloadId === null && d.downloadId !== null) folderDownloadId = d.downloadId;
    }
    if (d.note) li.append(node("span", "bill-item-note", d.note));
    el.docs.append(li);
  }
  el.docs.hidden = false;
  el.btnDocsFolder.hidden = folderDownloadId === null;
}

function renderNextSteps(s) {
  const bill = s.bill;
  const done = s.step === "done" || (bill && bill.existing && bill.existing.status === "item-saved");
  el.next.hidden = !done;
  if (!done) return;
  const r = bill.receipt;
  const where = r.source === "CRN" ? "PO Search > Consignment Receipt Note (CRN)" : "PO Search > Receipt Note (R-NOTE)";
  const folder = s.documents ? `Downloads/${s.documents.folder}/` : "the documents folder (step 5)";
  const steps = [
    `In IREPS open ${where} for PO ${r.poNo} and click bill ${bill.billRegNo} (View / Sign & Submit Draft Supplier Bill), or open it from the PO's Bills for Pay tab.`,
    `For each document: type the description shown above, click Select File, pick the file from ${folder} and sign it with your DSC.`,
    "Click Generate Preview and check every value against the invoice.",
    "Click Sign & Submit Bill, select your DSC and enter the PIN."
  ];
  el.nextSteps.replaceChildren(...steps.map((t) => node("li", null, t)));
}

function updateCreateButton() {
  const s = state;
  if (!s || !s.bill || !s.bill.header) return;
  const checks = s.bill.header.checks || [];
  const errors = checks.some((c) => c.level === "error");
  const warnings = checks.some((c) => c.level === "warning");
  const edited = Object.keys(overridesFromForm()).length > 0;
  el.btnApply.hidden = !edited;
  el.btnCreate.disabled = s.busy || s.step !== "review" || errors || edited || !el.confirm.checked || (warnings && !el.ack.checked);
}

function updateItemButton() {
  const s = state;
  const checks = (s && s.bill && s.bill.item && s.bill.item.checks) || [];
  const warnings = checks.some((c) => c.level === "warning");
  el.btnSaveItem.disabled = !s || s.busy || (warnings && !el.itemAck.checked);
}

/* -------------------------------------------------------------------------- */
/* render(state)                                                              */
/* -------------------------------------------------------------------------- */

function render(s) {
  if (!s) return;
  const previousStep = state && state.step;
  state = s;
  const steps = ["receipts", "review", "item-review", "item-blocked", "item-error", "done"];
  const at = (name) => steps.indexOf(s.step) >= steps.indexOf(name) && s.step !== "idle";

  // 1. receipts
  if (s.poNo && document.activeElement !== el.po) el.po.value = s.poNo;
  setBusy(el.btnSearch, s.busy && s.step === "idle");
  el.btnSearch.disabled = s.busy || at("review");
  renderReceipts(s);

  // 2. invoice
  if (s.step === "idle") selectedKey = null;
  el.stepInvoice.hidden = !(s.step === "receipts" ? selectedKey : at("review"));
  for (const r of el.modeRadios) r.disabled = s.busy || s.step !== "receipts";
  el.manual.hidden = currentInvoiceMode() !== "manual";
  el.btnPrepare.disabled = s.busy || s.step !== "receipts";
  setBusy(el.btnPrepare, s.busy && s.step === "receipts");

  // 3. review
  const bill = s.bill;
  el.stepReview.hidden = !(bill && bill.header);
  if (bill && bill.header) {
    renderReview(el.review, bill.header.review, s.step === "review" && !s.busy);
    renderChecks(el.checks, bill.header.checks);
    el.ackRow.hidden = !bill.header.checks.some((c) => c.level === "warning") || s.step !== "review";
    if (previousStep !== "review" || s.step !== "review") {
      el.confirm.checked = false;
      el.ack.checked = false;
    }
    el.confirm.disabled = s.step !== "review" || s.busy;
    el.btnCreate.hidden = s.step !== "review";
    el.confirm.parentElement.hidden = s.step !== "review";
    setBusy(el.btnCreate, s.busy && s.step === "review");
    updateCreateButton();
  }

  // 4. bill in IREPS
  const billRegNo = bill && bill.billRegNo;
  const showResult = Boolean(billRegNo) && at("item-review");
  el.stepResult.hidden = !showResult;
  if (showResult) {
    const item = bill.item;
    el.result.className = `result ${s.step === "done" ? "result-success" : "result-error is-notice"}`;
    if (s.step === "done") {
      el.resultTitle.textContent = `Draft bill ${billRegNo} created in IREPS`;
      el.resultText.textContent = `Header and item are saved${bill.dispatchNo ? ` (dispatch no. ${bill.dispatchNo})` : ""}. IREPS attached the receipt itself. The bill is NOT submitted yet: attach the documents, then sign and submit it in IREPS.`;
    } else if (s.step === "item-review") {
      el.resultTitle.textContent = `Draft bill ${billRegNo} created - item not saved yet`;
      el.resultText.textContent = "Check the item values and warnings below, then save the item.";
    } else if (s.step === "item-blocked") {
      el.resultTitle.textContent = `Draft bill ${billRegNo} created - item NOT saved`;
      el.resultText.textContent = "A check below stops DocLink from saving the item. Fill the item in IREPS yourself (open the draft bill), or delete the draft from the PO's Bills for Pay.";
    } else {
      el.resultTitle.textContent = `Draft bill ${billRegNo} created - item NOT saved`;
      el.resultText.textContent = "Saving the item failed (see the message below). You can try again, or finish the item in IREPS.";
    }
    renderReview(el.itemReview, item ? item.review : [], false);
    renderChecks(el.itemChecks, item ? item.checks : []);
    const canSave = s.step === "item-review" || s.step === "item-error";
    el.btnSaveItem.hidden = !canSave;
    el.itemAckRow.hidden = !(canSave && item && item.checks.some((c) => c.level === "warning"));
    if (previousStep !== s.step) el.itemAck.checked = false;
    setBusy(el.btnSaveItem, s.busy && canSave);
    updateItemButton();
  }

  // 5. documents (any time the invoice is known)
  el.stepDocs.hidden = !(bill && bill.header);
  el.btnDocs.disabled = s.busy;
  setBusy(el.btnDocs, s.busy && /documents/i.test(s.message || ""));
  renderDocuments(s);
  renderNextSteps(s);

  // progress / error
  el.progress.hidden = !s.busy;
  el.progressMessage.textContent = s.message || "";
  renderError(s.error);
  el.btnReset.disabled = s.busy;
  if (s.busy) ctx.setConnection("connected", "Connected");
}

function currentInvoiceMode() {
  const checked = el.modeRadios.find((r) => r.checked);
  return checked ? checked.value : "ecm";
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function search() {
  renderError(null);
  selectedKey = null;
  await request(MESSAGE_TYPES.BILL_UPLOAD_SEARCH, { poNo: el.po.value.trim() });
}

function manualInvoiceFields() {
  const date = el.invDate.value; // yyyy-mm-dd
  return {
    invoiceNumber: el.invNumber.value.trim(),
    invoiceDate: date,
    amount: el.invAmount.value.replace(/,/g, "").trim(),
    quantity: el.invQty.value.trim(),
    hsn: el.invHsn.value.trim(),
    division: el.invDivision.value,
    supplyPlace: el.invPlace.value.trim()
  };
}

async function prepare() {
  renderError(null);
  const radio = el.receipts.querySelector('input[name="bill-receipt"]:checked');
  const receiptKey = radio ? radio.value : selectedKey;
  if (!receiptKey) {
    renderError(describeError("BILL_NOT_PREPARED", { detail: "Choose a receipt first" }));
    return;
  }
  const invoiceMode = currentInvoiceMode();
  await request(MESSAGE_TYPES.BILL_UPLOAD_PREPARE, { receiptKey, invoiceMode, manualInvoice: invoiceMode === "manual" ? manualInvoiceFields() : null });
}

async function applyChanges() {
  renderError(null);
  await request(MESSAGE_TYPES.BILL_UPLOAD_REVIEW, { overrides: overridesFromForm() });
}

async function create() {
  renderError(null);
  await request(MESSAGE_TYPES.BILL_UPLOAD_CREATE, { confirmed: el.confirm.checked, acknowledged: el.ack.checked });
}

async function saveItemDetails() {
  renderError(null);
  await request(MESSAGE_TYPES.BILL_UPLOAD_SAVE_ITEM, { acknowledged: el.itemAck.checked });
}

async function documents() {
  renderError(null);
  await request(MESSAGE_TYPES.BILL_UPLOAD_DOCUMENTS);
}

async function reset() {
  renderError(null);
  selectedKey = null;
  el.po.value = "";
  const response = await request(MESSAGE_TYPES.BILL_UPLOAD_RESET);
  if (response && response.ok !== false) render(await ctx.send(MESSAGE_TYPES.BILL_UPLOAD_GET_STATE));
}

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ send: Function, showView: Function, setConnection: Function, setConnectionForError: Function, currentPanelTabId: () => Promise<number|null> }} context
 */
export function initBillUpload(context) {
  ctx = context;
  bindElements();
  el.btnOpen.addEventListener("click", async () => {
    ctx.showView("upload");
    render(await ctx.send(MESSAGE_TYPES.BILL_UPLOAD_GET_STATE));
  });
  el.btnBack.addEventListener("click", () => ctx.showView("main"));
  el.btnSearch.addEventListener("click", search);
  el.po.addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
  });
  for (const r of el.modeRadios) r.addEventListener("change", () => (el.manual.hidden = currentInvoiceMode() !== "manual"));
  el.btnPrepare.addEventListener("click", prepare);
  el.review.addEventListener("input", updateCreateButton);
  el.review.addEventListener("change", updateCreateButton);
  el.btnApply.addEventListener("click", applyChanges);
  el.confirm.addEventListener("change", updateCreateButton);
  el.ack.addEventListener("change", updateCreateButton);
  el.btnCreate.addEventListener("click", create);
  el.itemAck.addEventListener("change", updateItemButton);
  el.btnSaveItem.addEventListener("click", saveItemDetails);
  el.btnDocs.addEventListener("click", documents);
  el.btnDocsFolder.addEventListener("click", () => {
    if (folderDownloadId !== null) chrome.downloads.show(folderDownloadId);
  });
  el.btnOpenIreps.addEventListener("click", () => ctx.send(MESSAGE_TYPES.OPEN_IREPS));
  el.btnReset.addEventListener("click", reset);
}

/** Broadcasts from the service worker; true when handled. */
export function handleBillUploadMessage(message) {
  if (message.type !== MESSAGE_TYPES.BILL_UPLOAD_UPDATE) return false;
  render(message.state);
  return true;
}

/** On panel open: show a bill upload that is running or waiting for the user. */
export async function restoreBillUpload() {
  const s = await ctx.send(MESSAGE_TYPES.BILL_UPLOAD_GET_STATE);
  if (!s || s.step === undefined) return false;
  render(s);
  if (s.busy || ["review", "item-review", "item-error"].includes(s.step)) {
    ctx.showView("upload");
    return true;
  }
  return false;
}
