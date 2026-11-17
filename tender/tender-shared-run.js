// Scheduled downloads, Phase 2 (tender documents). While a scheduled run goes on in the background runner
// tab (schedule-runner.js), the tender code saves through these hooks instead of the per-user pieces:
//   - every document is reserved for the IREPS account before it is fetched; one that anyone already saved
//     is skipped without a question (no "download again?" prompt: nobody is looking at the runner tab);
//   - it goes to the ECM only, never to Downloads (tender-ecm.js tenderEcmSink, tender-core.js createSaver);
//   - each saved file is reported to the Recon Engine with its download-log record.
// Outside the runner tab nothing is installed and the tender code behaves exactly as before.
// The hooks are services/scheduler/shared-run-hooks.js `tenderHooks`.

let current = null;

/** The installed hooks ({ reserveDocuments, ecmSink, documentSaved }), or null in a manual run. */
export const sharedRun = () => current;

/** Install `hooks` for this page's one scheduled run. */
export function beginSharedRun(hooks) {
  current = hooks;
}

export function endSharedRun() {
  current = null;
}

/**
 * The ledger a scheduled run keeps, apart from the user's own: a document the user once downloaded to
 * Local must not make a scheduled run skip it (the Recon Engine's reservations decide what is saved).
 */
export const ledgerIdFor = (accountId) => (current ? `${accountId}#scheduled` : accountId);

/** The code of a local save a scheduled run refuses (utils/messages.js). */
export const LOCAL_SAVE_REFUSED = 'SCHEDULE_DESTINATION_REFUSED';
