/**
 * Upload one supporting document to a draft bill in IREPS (upload.md, step 9), the way the
 * bill page does it for "Upload Document", but with the PDF handed over by DocLink instead of
 * picked in the signer's Browse window:
 *
 *   1. sign     wss://127.0.0.1:2175 (eMudhra IREPS signer)  action=pdfsign tbs=<base64 PDF> signaction=2
 *               -> the user selects the DSC and enters the PIN in the signer's own window
 *   2. store    POST /cgi-bin/save.php  multipart, pdfContent = signed PDF   -> OK~<path>~<bytes>
 *   3. register POST /epsn/ct/uploadBillDocuments.do  fileDesc, filePath     -> OK#<n><>...document list
 *
 * Signing is never done by DocLink: the signer asks the user for the certificate and PIN. The
 * signer socket and save.php run inside the IREPS tab (background/bill-tab-request.js), so
 * they leave from the portal's origin like the page's own calls.
 *
 * Message format, chunking and reply fields copied from IREPS' CRISPKI.js (SignPdfData,
 * setData, callSocketDatax, Accept('SIGNPDF_SOCKET')) and the non-stock capture (#364, #390,
 * #374-#383).
 */

import { IrepsError } from "../ireps-api.js";
import { BILL_ERROR, postBill, orderedBody, parseDocumentList } from "./bill-upload-api.js";

export const UPLOAD_DOCUMENT_ENDPOINT = "/epsn/ct/uploadBillDocuments.do";
export const SAVE_FILE_ENDPOINT = "/cgi-bin/save.php";

/** The signer refuses 8 MB or more (CRISPKI: OriginalByteLength >= 8388608). */
export const MAX_SIGN_BYTES = 8388608;
/** IREPS: "Please Enter min. 5 characters in File Description!" */
export const MIN_DESCRIPTION = 5;
/** CRISPKI bufLengthWS: the signer takes the message in frames of this many characters. */
export const SIGNER_FRAME = 16300;

export const UPLOAD_DOCUMENT_FIELDS = Object.freeze(["billRegNo", "dispatchNo", "vendorCode", "fileName", "filePath", "fileDesc", "spmBillRegNo", "supplementaryBillType"]);

/**
 * The pdfsign request for a PDF DocLink passes in (CRISPKI.SignPdfData, signer v1.5), with the
 * placement the bill page uses for its documents (SignPDF: 90,90,10,10, IREPS-CRIS, New Delhi,
 * every page).
 */
export function signerRequest({ pdfBase64, thumbprint }) {
  return [
    "action=pdfsign",
    `tbs=${pdfBase64}`,
    "signaction=2",
    "certtype=DS",
    "expirycheck=true",
    "issuername=",
    "signtype=detached",
    "coordinate=90,90,10,10",
    `thumbprint=${thumbprint}`,
    "reason=IREPS-CRIS",
    "location=New Delhi",
    "pageNo=all",
    "pagination=false"
  ].join("\n");
}

/**
 * The frames the signer reads: the message cut into SIGNER_FRAME pieces, "completed" appended
 * to the last one. The signer answers "sendmore" after every frame but the last.
 */
export function signerFrames(message, size = SIGNER_FRAME) {
  const frames = [];
  for (let i = 0; i < message.length; i += size) frames.push(message.slice(i, i + size));
  if (!frames.length) frames.push("");
  frames[frames.length - 1] += "completed";
  return frames;
}

const field = (text, key, next) => {
  const i = text.indexOf(key);
  if (i === -1) return "";
  const from = i + key.length;
  const j = next ? text.indexOf(next, from) : -1;
  return text.slice(from, j === -1 ? undefined : j).trim();
};

/**
 * The signer's answer: "signature= <base64>\nCommon name=...\nThumbprint= X\nKeyusage=...\n
 * TotalPages= n\nSignedByteLength= n\nOriginalByteLength= n\nFileName=\ncompleted",
 * or "signing canceled completed".
 */
export function parseSignerReply(text) {
  const raw = String(text || "");
  if (/signing cancel/i.test(raw)) throw new IrepsError(BILL_ERROR.SIGN_FAILED, "signing cancelled", { detail: "Signing was cancelled in the IREPS signer" });
  const signature = field(raw, "signature=", "Common name=").replace(/\s+/g, "");
  if (signature.length < 1000) {
    const why = signature === "ex" || signature.length === 2 ? "the signer says this PDF file is corrupted" : `the signer did not return a signed PDF (${raw.slice(0, 80).replace(/\s+/g, " ") || "empty answer"})`;
    throw new IrepsError(BILL_ERROR.SIGN_FAILED, "no signature", { detail: why });
  }
  return {
    signedBase64: signature,
    thumbprint: field(raw, "Thumbprint=", "Keyusage=").toUpperCase(),
    pages: Number(field(raw, "TotalPages=", "SignedByteLength=")) || null,
    signedBytes: Number(field(raw, "SignedByteLength=", "OriginalByteLength=")) || null,
    originalBytes: Number(field(raw, "OriginalByteLength=", "FileName=")) || null
  };
}

/** save.php: "<html><body onload='...afterUpload()'>OK~<path>~<bytes></body></html>". */
export function parseSaveResult(text) {
  const body = String(text || "").replace(/<[^>]*>/g, "").trim();
  const parts = body.split("~");
  if (parts[0] !== "OK" || !parts[1]) {
    throw new IrepsError(BILL_ERROR.IREPS_REJECTED, "save.php refused the file", { detail: `IREPS did not store the file: ${body.slice(0, 200) || "empty answer"}` });
  }
  return { path: parts[1].trim(), bytes: Number(parts[2]) || null };
}

/** IREPS keeps [0-9A-Za-z._~-] of the file name (billFunctions.js uploadResult). */
export function irepsFileName(name) {
  let base = String(name || "").split(/[\\/]/).pop().replace(/[^0-9A-Za-z._~-]/g, "");
  if (!/\.pdf$/i.test(base)) base = `${base.replace(/\.+$/, "")}.pdf`;
  if (base === ".pdf") base = "document.pdf";
  return base;
}

/** ireps/upload/billDocuments/<MMYYYY>/<billRegNo>/<dispatchNo> (billFunctions.js uploadFile). */
export function billDocumentsDir({ billRegNo, dispatchNo }, today = new Date()) {
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  return `ireps/upload/billDocuments/${mm}${today.getFullYear()}/${billRegNo}/${dispatchNo}`;
}

const isPdf = (bytes) => bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d; // %PDF-

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * WRITES: sign, store and register one PDF on the draft bill.
 * @param {{ bill: { billRegNo: string, dispatchNo: string, vendorCode: string, thumbprint: string, spmBillRegNo?: string },
 *           file: { name: string, base64: string }, fileDesc: string }} input
 * @param {{ fetch: typeof fetch, signPdf: (frames: string[]) => Promise<string>,
 *           saveFile: (form: object) => Promise<string>, today?: Date }} deps
 * @returns {Promise<{ fileName: string, filePath: string, bytes: number|null, documents: object[] }>}
 */
export async function uploadBillDocument({ bill, file, fileDesc }, deps) {
  const desc = String(fileDesc || "").trim();
  if (desc.length < MIN_DESCRIPTION) throw new IrepsError(BILL_ERROR.DOC_INVALID, "description too short", { detail: `Enter a description of at least ${MIN_DESCRIPTION} characters` });
  if (!bill || !bill.billRegNo || !bill.dispatchNo) throw new IrepsError(BILL_ERROR.NOT_PREPARED, "no saved item", { detail: "Documents can be added once the bill item is saved (IREPS needs the dispatch no.)" });
  if (!bill.thumbprint) throw new IrepsError(BILL_ERROR.SIGN_FAILED, "no certificate thumbprint", { detail: "The IREPS bill page did not show your registered DSC (certThumbprint)" });
  if (!file || !file.base64) throw new IrepsError(BILL_ERROR.DOC_INVALID, "no file", { detail: "Choose the PDF first" });
  let bytes;
  try {
    bytes = base64ToBytes(file.base64);
  } catch {
    throw new IrepsError(BILL_ERROR.DOC_INVALID, "not base64", { detail: `${file.name} could not be read` });
  }
  if (!isPdf(bytes)) throw new IrepsError(BILL_ERROR.DOC_INVALID, "not a PDF", { detail: `${file.name} is not a PDF file` });
  if (bytes.length >= MAX_SIGN_BYTES) throw new IrepsError(BILL_ERROR.DOC_INVALID, "too large", { detail: `${file.name} is ${(bytes.length / 1048576).toFixed(1)} MB; IREPS takes PDFs below 8 MB` });

  // 1. sign (the user picks the certificate and enters the PIN in the signer)
  const reply = await deps.signPdf(signerFrames(signerRequest({ pdfBase64: file.base64, thumbprint: bill.thumbprint })));
  const signed = parseSignerReply(reply);
  if (signed.thumbprint && signed.thumbprint !== bill.thumbprint.toUpperCase()) {
    throw new IrepsError(BILL_ERROR.SIGN_FAILED, "other certificate", { detail: "Please sign with your own certificate (the one registered in IREPS)" });
  }

  // 2. store the signed PDF
  const fileName = irepsFileName(file.name);
  const relativeDir = billDocumentsDir(bill, deps.today);
  const saved = parseSaveResult(await deps.saveFile({ relativeDir, pdfName: fileName, pdfContent: signed.signedBase64 }));

  // 3. register it on the bill
  const values = {
    billRegNo: bill.billRegNo,
    dispatchNo: bill.dispatchNo,
    vendorCode: bill.vendorCode,
    fileName,
    filePath: saved.path,
    fileDesc: desc,
    spmBillRegNo: bill.spmBillRegNo || "null",
    supplementaryBillType: ""
  };
  const { text } = await postBill(UPLOAD_DOCUMENT_ENDPOINT, orderedBody(UPLOAD_DOCUMENT_FIELDS, values), { fetch: deps.fetch });
  if (!text.startsWith("OK#")) {
    throw new IrepsError(BILL_ERROR.IREPS_REJECTED, "uploadBillDocuments refused", { detail: `IREPS stored the file but did not add it to bill ${bill.billRegNo}: ${text.replace(/<[^>]+>/g, " ").trim().slice(0, 200) || "empty answer"}` });
  }
  return { fileName, filePath: saved.path, bytes: saved.bytes, documents: parseDocumentList(text) };
}
