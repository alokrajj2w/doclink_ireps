/**
 * Bill upload view of the DocLink panel ("Upload Bill to IREPS"): a thin view over the
 * service worker's bill upload job (background/bill-upload-job.js). Every button sends one
 * BILL_UPLOAD_* request; the job answers { started } and reports progress and results as
 * BILL_UPLOAD_UPDATE with its whole public state, which render() draws:
 *
 *   1. Receipt   PO number -> R-NOTE / CRN receipts, billable ones selectable
 *   2. Invoice   from ECM, from a JSON file the user picks (invoice-file.js), or typed by hand
 *   3. Header    every value with its source, editable where DocLink can only derive it,
 *                the checks; "Create draft bill" only with no errors, warnings read and the
 *                values confirmed
 *   4. Bill      bill reg no., the item values and checks; "Save item details" when the item
 *                waits for the user
 *   5. Documents the invoice's ECM documents saved locally with the IREPS description to type,
 *                and the steps left in IREPS
 *
 * When IREPS's answer to a write did not arrive, the step it belongs to shows what to check in
 * IREPS and stays stopped until the user confirms they checked (BILL_UPLOAD_CONFIRM_CHECKED).
 *
 * Built with textContent only; nothing from IREPS or ECM is inserted as HTML.
 */

import { MESSAGE_TYPES, describeError } from "../utils/messages.js";
import { parseInvoiceFile, invoiceFromFile, receiptInvoiceKey, MAX_INVOICE_FILE_BYTES } from "../services/bill-upload/invoice-file.js";

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
    fileBox: $("bill-file"),
    fileInput: $("bill-file-input"),
    fileStatus: $("bill-file-status"),
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
    forget: $("bill-forget"),
    forgetText: $("bill-forget-text"),
    forgetConfirm: $("bill-forget-confirm"),
    btnForget: $("btn-bill-forget"),
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
    upDoc: $("bill-upload-doc"),
    upDocHint: $("bill-upload-doc-hint"),
    upDocFile: $("bill-upload-doc-file"),
    upDocType: $("bill-upload-doc-type"),
    upDocDesc: $("bill-upload-doc-desc"),
    btnUpDoc: $("btn-bill-upload-doc"),
    upDocStatus: $("bill-upload-doc-status"),
    onIreps: $("bill-on-ireps"),
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
  buildUnknownBox();
}

/**
 * The "check IREPS first" box (review 3.1): what DocLink sent, why its answer is missing, what to
 * check in IREPS, and the confirmation that lets the step be sent again. Built here (textContent
 * only) and moved next to the step it stops.
 */
function buildUnknownBox() {
  const box = node("div", "bill-forget");
  box.hidden = true;
  const text = node("p", "bill-check bill-check-error");
  const label = node("label", "bill-confirm");
  const confirm = node("input");
  confirm.type = "checkbox";
  const confirmText = node("span");
  label.append(confirm, confirmText);
  const button = node("button", "btn btn-secondary");
  button.type = "button";
  button.disabled = true;
  box.append(text, label, button);
  confirm.addEventListener("change", () => {
    button.disabled = !state || state.busy || !confirm.checked;
  });
  button.addEventListener("click", confirmChecked);
  Object.assign(el, { unknown: box, unknownText: text, unknownConfirm: confirm, unknownConfirmText: confirmText, btnUnknown: button });
}

/** The receipt the user picked (radio), kept across re-renders. */
let selectedKey = null;
/** The receipt the typed invoice fields belong to: another receipt starts with empty fields (review 3.4). */
let manualFor = null;
/** The last draft bill shown: once a bill is created, the typed invoice fields are emptied. */
let shownBillRegNo = null;
/** The unconfirmed write the box shows ("step|at"), so its tick is cleared when another one appears. */
let shownUnknown = null;
/** The picked invoice file, { name, records }; kept for the next receipt after "Start over". */
let loadedFile = null;
let fileProblem = null;
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
      // an invoice typed for one receipt is never sent for another (review 3.4)
      if (manualFor !== null && manualFor !== r.key) clearManualInvoice();
      el.stepInvoice.hidden = false;
      renderFileStatus();
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

/** The write whose answer did not arrive ({ step, at, text, confirm, button }), or null. */
const unknownOf = (s) => (s && s.bill && s.bill.unknown) || null;

/* Upload one PDF to the draft bill (signed in the IREPS signer). */
const UPLOAD_MAX_BYTES = 8388608;

function updateUploadDocButton() {
  const s = state;
  const file = el.upDocFile.files && el.upDocFile.files[0];
  el.btnUpDoc.disabled = !s || s.busy || Boolean(unknownOf(s)) || !file || el.upDocDesc.value.trim().length < 5;
}

function renderUploadDoc(s) {
  const bill = s.bill;
  const blocked = Boolean(unknownOf(s));
  const ready = Boolean(bill && bill.billRegNo && bill.dispatchNo) && !blocked;
  el.upDoc.hidden = !(bill && bill.header && bill.billRegNo);
  if (el.upDoc.hidden) return;
  if (!el.upDocType.options.length) {
    for (const t of s.documentTypes || []) {
      const o = node("option", null, t.label);
      o.value = t.fileDesc;
      el.upDocType.append(o);
    }
    const other = node("option", null, "Other (type the description)");
    other.value = "";
    el.upDocType.append(other);
    if (!el.upDocDesc.value) el.upDocDesc.value = el.upDocType.value;
  }
  el.upDocHint.textContent = blocked
    ? `IREPS's answer to an earlier step of bill ${bill.billRegNo} did not arrive. Check the bill in IREPS and confirm it below before you upload a document.`
    : ready
      ? `Adds the PDF to draft bill ${bill.billRegNo} (dispatch no. ${bill.dispatchNo}), like "Upload Document" on the IREPS bill page.`
      : `Save the bill item first: IREPS takes documents once bill ${bill.billRegNo} has a dispatch no.`;
  for (const input of [el.upDocFile, el.upDocType, el.upDocDesc]) input.disabled = s.busy || !ready;
  setBusy(el.btnUpDoc, s.busy && /signer/i.test(s.message || ""));
  updateUploadDocButton();
  if (!ready) el.btnUpDoc.disabled = true;

  const up = s.docUpload;
  el.upDocStatus.hidden = !(up && up.billRegNo === bill.billRegNo);
  if (!el.upDocStatus.hidden) el.upDocStatus.textContent = `Uploaded ${up.fileName} as "${up.fileDesc}" to bill ${up.billRegNo}.`;

  const docs = bill.documentsOnBill || [];
  el.onIreps.replaceChildren();
  for (const d of docs) {
    const li = node("li", "bill-item");
    li.append(node("span", "bill-item-title", `${d.description || "-"}: ${d.fileName}`));
    li.append(node("span", "bill-item-detail", [d.uploadedAt, d.uploadedBy].filter(Boolean).join(" - ")));
    el.onIreps.append(li);
  }
  el.onIreps.hidden = docs.length === 0;
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("could not read the file"));
    reader.readAsDataURL(file);
  });
}

async function uploadDocument() {
  renderError(null);
  const file = el.upDocFile.files && el.upDocFile.files[0];
  if (!file) return;
  if (file.size >= UPLOAD_MAX_BYTES) {
    renderError(describeError("BILL_DOC_INVALID", { detail: `${file.name} is ${(file.size / 1048576).toFixed(1)} MB; IREPS takes PDFs below 8 MB` }));
    return;
  }
  let base64;
  try {
    base64 = await readFileBase64(file);
  } catch (error) {
    renderError(describeError("BILL_DOC_INVALID", { detail: `${file.name} could not be read: ${(error && error.message) || error}` }));
    return;
  }
  const response = await request(MESSAGE_TYPES.BILL_UPLOAD_ADD_DOCUMENT, { file: { name: file.name, base64 }, fileDesc: el.upDocDesc.value });
  if (response && response.started !== false) el.upDocFile.value = "";
}

const receiptSearchIn = (r) => (r.source === "CRN" ? "PO Search > Consignment Receipt Note (CRN)" : "PO Search > Receipt Note (R-NOTE)");

/** IREPS's own upload of the receipt, on every bill once its item is saved. */
const SYSTEM_UPLOAD = /SYSTEM UPLOAD/i;
const sameText = (a, b) => String(a || "").replace(/\s+/g, " ").trim().toUpperCase() === String(b || "").replace(/\s+/g, " ").trim().toUpperCase();
const NEED_NOTE = { conditional: " (if the inspection needs it)", optional: " (if applicable)" };

/**
 * The "Finish in IREPS" steps, built from the documents' actual states (review L13): what is on
 * the bill in IREPS already (the receipt IREPS attached, every document uploaded from DocLink) is
 * not asked for again, the files DocLink saved from ECM are named, and a needed document DocLink
 * has no file for is named so the user finds it. Pure (no DOM), exported for the tests.
 * @param {object} s  the job's public state (bill-upload-job.js publicState), item saved
 * @returns {string[]}
 */
export function finishSteps(s) {
  const bill = s.bill;
  const r = bill.receipt;
  const steps = [`In IREPS open ${receiptSearchIn(r)} for PO ${r.poNo} and click bill ${bill.billRegNo} (View / Sign & Submit Draft Supplier Bill), or open it from the PO's Bills for Pay tab.`];
  const onBill = (bill.documentsOnBill || []).filter((d) => !SYSTEM_UPLOAD.test(d.description || ""));
  const isOnBill = (fileDesc) => onBill.some((d) => sameText(d.description, fileDesc));
  if (onBill.length) steps.push(`Already on the bill, so don't attach ${onBill.length === 1 ? "it" : "them"} again: ${onBill.map((d) => d.description || d.fileName).join(", ")}.`);
  const found = s.documents;
  if (!found) {
    steps.push(`${onBill.length ? "Attach every other document the bill needs" : "Attach each document the bill needs that is not on it yet"}: type its description, click Select File, pick the file and sign it with your DSC. "Get documents from ECM" above saves the ECM documents and shows the description to type.`);
  } else {
    const open = found.documents.filter((d) => d.need !== "not-needed" && !isOnBill(d.fileDesc));
    const toAttach = open.filter((d) => d.status === "saved");
    const noFile = open.filter((d) => d.status !== "saved" && (d.need === "required" || d.need === "conditional"));
    if (toAttach.length) {
      steps.push(`Attach the files DocLink saved in Downloads/${found.folder}/ that are not on the bill yet: ${toAttach.map((d) => `${d.label}${NEED_NOTE[d.need] || ""}`).join("; ")}. For each one, type the description shown above, click Select File, pick the file and sign it with your DSC.`);
    }
    // the list above shows the description to type only for the files it saved
    if (noFile.length) {
      steps.push(`Attach your own copy of what DocLink could not get from ECM (type the description, click Select File, pick the file and sign it with your DSC): ${noFile.map((d) => `${d.label}${NEED_NOTE[d.need] || ""}, ${DOC_STATUS[d.status] || d.status}, description "${d.fileDesc}"`).join("; ")}.`);
    }
    if (!toAttach.length && !noFile.length) steps.push("Every document DocLink found in ECM is on the bill already.");
  }
  steps.push("Click Generate Preview and check every value against the invoice.");
  steps.push("Click Sign & Submit Bill, select your DSC and enter the PIN.");
  for (const b of bill.forgottenBills || []) {
    steps.push(`Draft bill ${b.billRegNo}, which DocLink forgot when you chose Start fresh, is still in IREPS: delete it from the PO's Bills for Pay tab if you no longer need it.`);
  }
  return steps;
}

function renderNextSteps(s) {
  const bill = s.bill;
  const done = s.step === "done" || (bill && bill.existing && bill.existing.status === "item-saved");
  el.next.hidden = !done;
  if (!done) return;
  el.nextSteps.replaceChildren(...finishSteps(s).map((t) => node("li", null, t)));
}

/**
 * The "Start fresh" box (review M26). Before: what forgetting the earlier bill means. After: that
 * the forgotten draft is still in IREPS and where to find it, since DocLink no longer tracks it.
 * Pure (no DOM), exported for the tests.
 * @param {object|null} bill  the job's public bill state
 * @returns {{ text: string, offer: boolean }|null}  offer: show the confirmation and the button
 */
export function startFreshText(bill) {
  if (!bill || !bill.receipt) return null;
  const r = bill.receipt;
  const findIt = `find it on the PO's Bills for Pay tab (or under ${receiptSearchIn(r)} for PO ${r.poNo}) and delete it there if you no longer need it`;
  // a header whose creation IREPS has not confirmed has no number: the "check IREPS first" box handles it
  if (bill.existing && bill.existing.billRegNo) {
    const no = bill.existing.billRegNo;
    return {
      offer: true,
      text: `An earlier try already created draft bill ${no} in IREPS for this receipt. To start again, DocLink can forget that bill and let you create a new one. Bill ${no} stays in IREPS, because DocLink never deletes a bill: ${findIt}.`
    };
  }
  const forgotten = (bill.forgottenBills || []).map((b) => b.billRegNo);
  if (!forgotten.length) return null;
  return {
    offer: false,
    text: `DocLink forgot draft bill ${forgotten.join(", ")}, so you can create a new bill for this receipt. The old draft is still in IREPS: ${findIt}.`
  };
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
  el.btnSaveItem.disabled = !s || s.busy || Boolean(unknownOf(s)) || (warnings && !el.itemAck.checked);
}

/** Next to the step it stops: the header's Create, the item's Save, the documents' Upload. */
function unknownAnchor(u) {
  if (u.step === "document" && !el.upDoc.hidden) return el.btnUpDoc;
  if (u.step !== "header" && !el.stepResult.hidden) return el.itemAckRow;
  if (!el.stepReview.hidden) return el.ackRow;
  return el.progress;
}

function renderUnknown(s, failed) {
  const u = unknownOf(s);
  el.unknown.hidden = !u;
  if (!u) {
    shownUnknown = null;
    el.unknownConfirm.checked = false;
    return;
  }
  const anchor = unknownAnchor(u);
  if (el.unknown.nextSibling !== anchor) anchor.parentElement.insertBefore(el.unknown, anchor);
  const id = `${u.step}|${u.at}`;
  if (shownUnknown !== id || failed) el.unknownConfirm.checked = false;
  shownUnknown = id;
  el.unknownText.textContent = u.text;
  el.unknownConfirmText.textContent = u.confirm;
  el.btnUnknown.textContent = u.button;
  el.unknownConfirm.disabled = s.busy;
  el.btnUnknown.disabled = s.busy || !el.unknownConfirm.checked;
}

function clearManualInvoice() {
  for (const input of [el.invNumber, el.invDate, el.invAmount, el.invQty, el.invHsn, el.invPlace]) input.value = "";
  el.invDivision.value = "";
  manualFor = null;
}

/* -------------------------------------------------------------------------- */
/* render(state)                                                              */
/* -------------------------------------------------------------------------- */

function render(s) {
  if (!s) return;
  const previousStep = state && state.step;
  // a step that just failed: every tick is given again for what is shown now (review 3.1)
  const failed = Boolean(state && state.busy && !s.busy && s.error);
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
  showModeFields();
  el.fileInput.disabled = s.busy || s.step !== "receipts";
  renderFileStatus();
  el.btnPrepare.disabled = s.busy || s.step !== "receipts";
  setBusy(el.btnPrepare, s.busy && s.step === "receipts");

  // 3. review
  const bill = s.bill;
  // once a draft bill exists, the invoice typed for it is not offered for the next one (review 3.4)
  const billRegNoShown = (bill && bill.billRegNo) || null;
  if (billRegNoShown && billRegNoShown !== shownBillRegNo) clearManualInvoice();
  shownBillRegNo = billRegNoShown;
  el.stepReview.hidden = !(bill && bill.header);
  if (bill && bill.header) {
    renderReview(el.review, bill.header.review, s.step === "review" && !s.busy);
    renderChecks(el.checks, bill.header.checks);
    el.ackRow.hidden = !bill.header.checks.some((c) => c.level === "warning") || s.step !== "review";
    if (previousStep !== "review" || s.step !== "review" || failed) {
      el.confirm.checked = false;
      el.ack.checked = false;
    }
    el.confirm.disabled = s.step !== "review" || s.busy;
    el.btnCreate.hidden = s.step !== "review";
    el.confirm.parentElement.hidden = s.step !== "review";
    setBusy(el.btnCreate, s.busy && s.step === "review");
    updateCreateButton();
  }

  // 3b. an earlier try already created a bill for this receipt -> offer to start fresh; once
  // forgotten, the box says where that bill is in IREPS
  const fresh = s.step === "review" ? startFreshText(bill) : null;
  el.forget.hidden = !fresh;
  if (fresh) {
    el.forgetText.textContent = fresh.text;
    el.forgetConfirm.parentElement.hidden = !fresh.offer;
    el.btnForget.hidden = !fresh.offer;
    if (previousStep !== "review" || !fresh.offer || failed) el.forgetConfirm.checked = false;
    el.forgetConfirm.disabled = s.busy;
    el.btnForget.disabled = s.busy || !el.forgetConfirm.checked;
  } else {
    el.forgetConfirm.checked = false;
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
    } else if (unknownOf(s) && unknownOf(s).step === "item") {
      el.resultTitle.textContent = `Draft bill ${billRegNo} created - item not confirmed`;
      el.resultText.textContent = "DocLink sent the item, but IREPS's answer did not arrive, so DocLink does not know whether IREPS saved it. Check the bill in IREPS before you save the item again (see below).";
    } else {
      el.resultTitle.textContent = `Draft bill ${billRegNo} created - item NOT saved`;
      el.resultText.textContent = "Saving the item failed (see the message below). You can try again, or finish the item in IREPS.";
    }
    renderReview(el.itemReview, item ? item.review : [], false);
    renderChecks(el.itemChecks, item ? item.checks : []);
    const canSave = s.step === "item-review" || s.step === "item-error";
    el.btnSaveItem.hidden = !canSave;
    el.itemAckRow.hidden = !(canSave && item && item.checks.some((c) => c.level === "warning"));
    if (previousStep !== s.step || failed) el.itemAck.checked = false;
    setBusy(el.btnSaveItem, s.busy && canSave);
    updateItemButton();
  }

  // 5. documents (any time the invoice is known)
  el.stepDocs.hidden = !(bill && bill.header);
  el.btnDocs.disabled = s.busy;
  setBusy(el.btnDocs, s.busy && /documents/i.test(s.message || ""));
  renderDocuments(s);
  renderUploadDoc(s);
  renderNextSteps(s);
  renderUnknown(s, failed);

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

function showModeFields() {
  const mode = currentInvoiceMode();
  el.manual.hidden = mode !== "manual";
  el.fileBox.hidden = mode !== "file";
}

/** What the picked file holds, and which of its invoices the selected receipt would use. */
function renderFileStatus() {
  if (fileProblem) {
    el.fileStatus.textContent = fileProblem;
    return;
  }
  if (!loadedFile) {
    el.fileStatus.textContent = "Choose the file with the invoices. It is read here, when you pick it; nothing is sent to IREPS before Prepare.";
    return;
  }
  const count = `Loaded ${loadedFile.name} (${loadedFile.loadedAt}): ${loadedFile.records.length} invoice${loadedFile.records.length === 1 ? "" : "s"}. Edited it? Choose it again.`;
  const key = (state && state.receiptKey) || selectedKey;
  const receipt = key && state ? state.receipts.find((r) => r.key === key) : null;
  if (!receipt) {
    el.fileStatus.textContent = `${count} Choose a receipt to see its invoice.`;
    return;
  }
  try {
    const invoice = invoiceFromFile(loadedFile, receiptInvoiceKey(receipt));
    el.fileStatus.textContent = `${count} This receipt: invoice ${invoice.invoiceNumber}${invoice.amount !== undefined ? `, amount ${invoice.amount}` : ""}.`;
  } catch (error) {
    el.fileStatus.textContent = `${count} ${(error && error.detail) || (error && error.message) || "No invoice for this receipt"}.`;
  }
}

async function loadInvoiceFile() {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (file) {
    // a cancelled picker leaves the loaded file as it was
    loadedFile = null;
    fileProblem = null;
    try {
      if (file.size > MAX_INVOICE_FILE_BYTES) throw new Error(`${file.name} is larger than 1 MB`);
      loadedFile = { ...parseInvoiceFile(await file.text(), file.name), loadedAt: new Date().toLocaleTimeString() };
    } catch (error) {
      fileProblem = (error && error.detail) || (error && error.message) || "The file could not be read";
    }
    // Chrome fires no "change" when the same file is picked again, so an edited file would
    // never be re-read: clear the input (the status line names the loaded file instead).
    el.fileInput.value = "";
  }
  renderFileStatus();
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
  if (invoiceMode === "file" && !loadedFile) {
    renderError(describeError("BILL_FILE_INVALID", { detail: fileProblem || "Choose the JSON file first" }));
    return;
  }
  if (invoiceMode === "manual") manualFor = receiptKey;
  await request(MESSAGE_TYPES.BILL_UPLOAD_PREPARE, {
    receiptKey,
    invoiceMode,
    manualInvoice: invoiceMode === "manual" ? manualInvoiceFields() : null,
    invoiceFile: invoiceMode === "file" ? loadedFile : null
  });
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

async function forget() {
  renderError(null);
  const response = await request(MESSAGE_TYPES.BILL_UPLOAD_FORGET);
  if (response && response.ok !== false) {
    el.forgetConfirm.checked = false;
    render(await ctx.send(MESSAGE_TYPES.BILL_UPLOAD_GET_STATE));
  }
}

/** The user checked the bill in IREPS after a write's answer did not arrive (review 3.1). */
async function confirmChecked() {
  renderError(null);
  const u = unknownOf(state);
  if (!u) return;
  const response = await request(MESSAGE_TYPES.BILL_UPLOAD_CONFIRM_CHECKED, { step: u.step, at: u.at, checked: el.unknownConfirm.checked });
  if (response && response.ok !== false) {
    el.unknownConfirm.checked = false;
    render(await ctx.send(MESSAGE_TYPES.BILL_UPLOAD_GET_STATE));
  }
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
  for (const r of el.modeRadios) r.addEventListener("change", showModeFields);
  // the typed invoice belongs to the receipt chosen while it was typed
  el.manual.addEventListener("input", () => {
    manualFor = selectedKey || (state && state.receiptKey) || manualFor;
  });
  el.fileInput.addEventListener("change", loadInvoiceFile);
  el.btnPrepare.addEventListener("click", prepare);
  el.review.addEventListener("input", updateCreateButton);
  el.review.addEventListener("change", updateCreateButton);
  el.btnApply.addEventListener("click", applyChanges);
  el.forgetConfirm.addEventListener("change", () => {
    el.btnForget.disabled = !state || state.busy || !el.forgetConfirm.checked;
  });
  el.btnForget.addEventListener("click", forget);
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
  el.upDocFile.addEventListener("change", updateUploadDocButton);
  el.upDocDesc.addEventListener("input", updateUploadDocButton);
  el.upDocType.addEventListener("change", () => {
    el.upDocDesc.value = el.upDocType.value;
    updateUploadDocButton();
    if (!el.upDocType.value) el.upDocDesc.focus();
  });
  el.btnUpDoc.addEventListener("click", uploadDocument);
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
