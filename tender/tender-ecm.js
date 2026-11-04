// Save to: ECM / S3, for tender documents.
// Under that choice each tender document is filed in the ECM (Nuxeo) folder of the IREPS account's
// unit instead of Downloads ("TSG India Doculink ECM specifications.xlsx", "ECM - Download speci-v1"),
// through the Recon Engine's ECM gateway, or straight to the ECM (services/ecm-service.js). A document the ECM does not take
// is saved locally as before; My Offer has no ECM type and always stays local.
//
// This module only READS the panel's Save to preference from chrome.storage.local; it stores nothing.

import { STORAGE_KEYS } from '../utils/messages.js';
import { SAVE_DESTINATION } from '../services/recon-service.js';
import { ECM_KIND, saveToEcmOrLocally } from '../services/ecm-service.js';
import { ECM_KINDS, isGroupedKind } from '../services/ecm-catalog.js';
import { confirmReconSignIn } from '../services/recon-auth.js';
import { loadEcmConfig, isDirectEcm } from '../services/ecm-config.js';
import { loadDownloadLogConfig } from '../services/download-log.js';
import { TenderError, safeSegment } from './tender-core.js';

export const SIGN_IN_REQUIRED_MSG = 'Sign in to the Recon Engine to download: DocLink records every download for the signed-in user. Nothing was downloaded.';

/**
 * Before any tender download: with the download log on (config.json "downloadLog") the user
 * must be signed in to the Recon Engine, whatever Save to says - the sign-in page asks, and
 * cancelling it stops the run (TenderError SIGN_IN_REQUIRED). A no-op with the log off.
 */
export async function ensureDownloadSignIn() {
  if (!(await loadDownloadLogConfig())) return;
  if (!(await confirmReconSignIn({ always: true }))) throw new TenderError('SIGN_IN_REQUIRED', SIGN_IN_REQUIRED_MSG);
}

/**
 * Tender category (tender-workflows newCategory) -> ECM kind. Categories not listed stay local.
 * NIT, LOA and Result are grouped kinds (services/ecm-catalog.js): one ECM document per tender,
 * "<T> - NIT" (the tender PDF, then its attached documents), "<T> - LOA" (every LOA letter),
 * "<T> - Result" (the Financial Tabulation), each further PDF an attachment of it.
 */
export const CATEGORY_ECM_KIND = Object.freeze({
  TENDER_PDF: ECM_KIND.NIT,
  ATTACHMENTS: ECM_KIND.NIT, //            "List of documents attached with the tender"
  CORRIGENDA: ECM_KIND.EXTENSION, //       tender extension / qty reduction / increase
  NEGOTIATION: ECM_KIND.NBSP, //           Negotiation Bid Submission Pending
  COUNTER_OFFER: ECM_KIND.COUNTER_OFFER,
  LOA: ECM_KIND.LOI, //                    Advance Acceptance Letter, "<T> - LOA"
  CORRESPONDENCE: ECM_KIND.CRP, //         Correspondence Reply pending
  FINANCIAL_TABULATION: ECM_KIND.TENDER_RESULT, // "<T> - Result" (ECM type "Tender Result")
  COMMERCIAL_TABULATION: ECM_KIND.COMMERCIAL_TABULATION, // vct
});

const TITLE_MAX = 200;

/** "2026-10-14T18:30:00.000Z" (a due date kept as an ISO instant) -> its local day "2026-10-15". */
function localDay(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The panel's Save to choice; Local when it cannot be read. */
export async function savedDestination() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SAVE_DESTINATION);
    return stored[STORAGE_KEYS.SAVE_DESTINATION] === SAVE_DESTINATION.RECON ? SAVE_DESTINATION.RECON : SAVE_DESTINATION.LOCAL;
  } catch {
    return SAVE_DESTINATION.LOCAL;
  }
}

/**
 * How one tender document is filed in the ECM, or null when its category has no ECM kind.
 * The title is "<tender no> - <kind code>" as "ECM - Download speci-v1" names it
 * ("29263265 - NIT", "29263265 - LOA"; codes in services/ecm-catalog.js). For a grouped kind
 * (NIT, LOA, Result) that is the whole title: every PDF of the kind goes into that one document.
 * Other kinds can hold several documents per tender (corrigenda, letters), so those add what
 * tells them apart: "29263265 - Extension - 1", "29263265 - NBSP - 1204920".
 * Only the fields the ECM has for the kind are sent (services/ecm-catalog.js): the tender
 * number, and the tender date (IREPS closing date) when the run knows it.
 *   action = the download action ({ id, meta: { title, docDate } }), ctx = run.ctx
 */
export function ecmDocumentFor(category, action, ctx) {
  const kind = CATEGORY_ECM_KIND[category];
  if (!kind) return null;
  const tenderNo = ctx.tenderNo;
  const meta = action.meta || {};
  const id = action.id || '';
  // grouped kinds and the Commercial Tabulation need nothing more: one document per tender
  const detail = isGroupedKind(kind) ? '' : {
    CORRIGENDA: meta.title || id,
    NEGOTIATION: id,
    COUNTER_OFFER: id,
    CORRESPONDENCE: meta.title || id,
  }[category];
  const known = { tender_number: tenderNo, tender_date: ctx.closingDate || localDay(ctx.dueDate) };
  const fields = Object.fromEntries(ECM_KINDS[kind].fields.filter((key) => key in known).map((key) => [key, known[key]]));
  const title = [tenderNo, ECM_KINDS[kind].code, detail].filter(Boolean).join(' - ');
  return { kind, title: title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX), fields };
}

/**
 * The document the download check (services/download-log.js preflightDownloads) looks up in
 * the ECM, or null. Grouped kinds are not looked up: all their PDFs share one title, so a
 * title match cannot say whether this PDF is there; the upload itself finds it by file name.
 */
export function ecmCheckDocumentFor(category, action, ctx) {
  const doc = ecmDocumentFor(category, action, ctx);
  return doc && !isGroupedKind(doc.kind) ? doc : null;
}

/**
 * The file name a PDF has in the ECM. Inside a grouped document file names tell the PDFs apart,
 * so an LOA letter always carries its letter id: locally a tender's only letter is
 * "LOA_<T>.pdf", which a second letter found on a later day would also be called.
 */
export function ecmFileName(category, fileName, id) {
  const safeId = safeSegment(String(id || ''));
  if (category !== 'LOA' || !id || safeId === 'NA') return fileName;
  const dot = fileName.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ''];
  return stem.endsWith(`_${safeId}`) ? fileName : `${stem}_${safeId}${ext}`;
}

/** Whether a tender document's ECM record holds the tender date (services/ecm-catalog.js lists tender_date). */
export const ECM_TAKES_TENDER_DATE = Object.values(CATEGORY_ECM_KIND).some((kind) => ECM_KINDS[kind].fields.includes('tender_date'));

/**
 * The run's ECM sink, or null when the Save to choice is Local (or the user chose Local
 * on the Recon Engine sign-in page, which is only shown when the gateway is used).
 *   sink.save(doc, saveLocally) -> { ecm, local }   (see ecm-service saveToEcmOrLocally)
 * The account is the run's verified IREPS account; its unit picks the ECM folder.
 */
export async function tenderEcmSink(account, deps = {}) {
  if ((await savedDestination()) !== SAVE_DESTINATION.RECON) return null;
  // Login 2: the Recon Engine sign-in page answers before the run; "Use Local instead" -> local.
  // Not needed when the documents go straight to the ECM (config.json "ecmBackendAws": false).
  await loadEcmConfig();
  if (!isDirectEcm() && !(await confirmReconSignIn())) return null;
  const acct = account?.verified ? { irepsAccountId: account.irepsAccountId, operatingUnit: account.operatingUnit } : {};
  return { save: (doc, saveLocally) => saveToEcmOrLocally({ ...doc, account: acct }, saveLocally, deps) };
}
