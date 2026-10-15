// Save to: ECM / S3, for tender documents.
// Under that choice each tender document is filed in the ECM (Nuxeo) folder of the IREPS account's
// unit instead of Downloads ("TSG India Doculink ECM specifications.xlsx", "ECM - Download speci-v1"),
// through the Recon Engine's ECM gateway (services/ecm-service.js). A document the ECM does not take
// is saved locally as before; My Offer has no ECM type and always stays local.
//
// This module only READS the panel's Save to preference from chrome.storage.local; it stores nothing.

import { STORAGE_KEYS } from '../utils/messages.js';
import { SAVE_DESTINATION } from '../services/recon-service.js';
import { ECM_KIND, saveToEcmOrLocally } from '../services/ecm-service.js';
import { confirmReconSignIn } from '../services/recon-auth.js';

/** Tender category (tender-workflows newCategory) -> ECM kind. Categories not listed stay local. */
export const CATEGORY_ECM_KIND = Object.freeze({
  TENDER_PDF: ECM_KIND.NIT,
  ATTACHMENTS: ECM_KIND.NIT, //            "List of documents attached with the tender"
  CORRIGENDA: ECM_KIND.EXTENSION, //       tender extension / qty reduction / increase
  NEGOTIATION: ECM_KIND.NBSP, //           Negotiation Bid Submission Pending
  COUNTER_OFFER: ECM_KIND.COUNTER_OFFER,
  LOA: ECM_KIND.LOI, //                    Advance Acceptance Letter / LOI
  CORRESPONDENCE: ECM_KIND.CRP, //         Correspondence Reply pending
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
 * Titles are explicit and unique within a tender (a tender holds several documents of a kind).
 *   action = the download action ({ id, meta: { title, docDate } }), ctx = run.ctx
 */
export function ecmDocumentFor(category, action, ctx) {
  const kind = CATEGORY_ECM_KIND[category];
  if (!kind) return null;
  const tenderNo = ctx.tenderNo;
  const meta = action.meta || {};
  const id = action.id || '';
  const label = {
    TENDER_PDF: 'NIT',
    ATTACHMENTS: `Attachment - ${meta.title || id}`,
    CORRIGENDA: `Corrigendum ${meta.title || id}`,
    NEGOTIATION: `Negotiation letter ${id}`,
    COUNTER_OFFER: `Counter Offer ${id}`,
    LOA: `LOA ${id}`,
    CORRESPONDENCE: `Correspondence ${meta.title || id}`,
  }[category];
  const fields = { tender_number: tenderNo, tender_date: ctx.closingDate || localDay(ctx.dueDate) };
  if (category === 'LOA') Object.assign(fields, { loi_number: id, loi_date: meta.docDate || '' });
  return { kind, title: `${tenderNo} - ${label}`.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX), fields };
}

/**
 * The run's ECM sink, or null when the Save to choice is Local (or the user chose Local
 * on the Recon Engine sign-in page).
 *   sink.save(doc, saveLocally) -> { ecm, local }   (see ecm-service saveToEcmOrLocally)
 * The account is the run's verified IREPS account; its unit picks the ECM folder.
 */
export async function tenderEcmSink(account, deps = {}) {
  if ((await savedDestination()) !== SAVE_DESTINATION.RECON) return null;
  // Login 2: the Recon Engine sign-in page answers before the run; "Use Local instead" -> local.
  if (!(await confirmReconSignIn())) return null;
  const acct = account?.verified ? { irepsAccountId: account.irepsAccountId, operatingUnit: account.operatingUnit } : {};
  return { save: (doc, saveLocally) => saveToEcmOrLocally({ ...doc, account: acct }, saveLocally, deps) };
}
