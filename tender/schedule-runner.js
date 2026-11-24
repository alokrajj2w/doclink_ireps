// The background tab of a scheduled tender download (Phase 2; services/scheduler/tender-runner.js opens it).
// The tender code needs a page (DOMParser, Chrome's print-to-PDF, chrome.downloads), so a tender slot this
// DocLink claimed runs here instead of in the worker:
//   READY -> the job (type, date range, verified IREPS account) -> the tender job, with the shared-run hooks
//   installed (tender-shared-run.js: reserve before download, ECM only, report each save) -> DONE (outcome).
// Every 20 s, and before an upload whenever its last answer is older, it asks the worker whether the claim is
// still live (the worker sends the heartbeats; tender-runner.js createClaimWatch, so Chrome throttling this hidden
// tab's timers never stops a healthy run); a run that lost its claim stops before its next upload. The worker
// closes this tab when the run ends.

import { MESSAGE_TYPES } from '../utils/messages.js';
import { createScheduleApi } from '../services/scheduler/schedule-api.js';
import { createSharedRunHooks } from '../services/scheduler/shared-run-hooks.js';
import { tenderRunOutcome, stoppedCode, createClaimWatch, RUNNER_PING_MS } from '../services/scheduler/tender-runner.js';
import { scheduledSearch } from '../services/scheduler/run-details.js';
import { beginSharedRun, endSharedRun } from './tender-shared-run.js';
import { TenderError, log } from './tender-core.js';
import { runAutomatic, runLetterType } from './tender-auto.js';
import { beginJob, downloadTabulationsByDate } from './tender-jobs.js';
import { downloadPendingCorrespondence } from './tender-pending.js';
import { closePrintTabs } from './tender-print.js';

const send = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });
const statusEl = document.getElementById('status');
const show = (text) => { if (statusEl) statusEl.textContent = text; };

/** "17/11/2026" -> that local day. */
const dateOf = (dmy) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dmy || ''));
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
};

/**
 * The tender job of each schedule type. Each reads its date range from the claim (dateFrom - dateTo, IST
 * days); Correspondence takes what IREPS lists as pending. Negotiation has its own, less frequent schedule.
 */
const JOBS = {
  tenderNit: (r) => runAutomatic(r),
  tenderCounterOffer: (r) => runLetterType({ ...r, status: 'MyCounterOffer' }),
  tenderLoa: (r) => runLetterType({ ...r, status: 'MyAdvanceAcceptanceLetter' }),
  tenderNegotiation: (r) => runLetterType({ ...r, status: 'MyNegotiation' }),
  tenderTabulations: async (r) => {
    const job = await beginJob(r);
    const tabulations = await downloadTabulationsByDate({ ...r, job });
    await job.ledger.save();
    return { tabulations };
  },
  tenderCorrespondence: (r) => downloadPendingCorrespondence({ mode: 'all', onProgress: r.onProgress, onAccount: r.onAccount }),
};

async function main() {
  const claimId = new URL(location.href).searchParams.get('claim') || '';
  const answer = await send(MESSAGE_TYPES.SCHEDULE_RUNNER_READY, { claimId }).catch(() => null);
  if (!answer || !answer.ok || !answer.job) {
    show('This scheduled download is no longer running. You can close this tab.');
    return;
  }
  const { job } = answer;

  // the claim is live while the worker's heartbeat is fresh; it was live when the worker opened this tab. The
  // interval keeps the answer fresh; a check before an upload asks again when it is old (a throttled timer)
  const watch = createClaimWatch({ ask: () => send(MESSAGE_TYPES.SCHEDULE_RUNNER_PING, { claimId }) });
  const pinger = setInterval(watch.refresh, RUNNER_PING_MS);

  const hooks = createSharedRunHooks({ api: createScheduleApi(), claimId, account: job.account, isClaimLive: watch.isClaimLive });
  const from = dateOf(job.params.dateFrom);
  const to = dateOf(job.params.dateTo);
  const onProgress = (text) => show(String(text || ''));
  // the run is for the account the worker verified: another account logged in here stops it before any download
  const onAccount = (a) => {
    if (a && a.verified && String(a.irepsAccountId) !== String(job.account.irepsAccountId)) {
      throw new TenderError('ACCOUNT_CHANGED', `IREPS account ${a.irepsAccountId} is logged in here, not ${job.account.irepsAccountId}.`);
    }
  };

  let result = null;
  let error = null;
  beginSharedRun(hooks.tenderHooks);
  try {
    const start = JOBS[job.docType];
    if (!start) throw new TenderError('SCHEDULE_TYPE_NOT_SUPPORTED', job.docType);
    if (job.docType !== 'tenderCorrespondence' && (!from || !to)) throw new TenderError('SCHEDULE_INVALID', 'no date range in the claim');
    log('Schedule', `scheduled ${job.docType} for ${job.params.dateFrom || ''} - ${job.params.dateTo || ''}`);
    result = await start({ from, to, onProgress, onAccount });
  } catch (e) {
    error = { code: e.code || 'UNKNOWN', message: e.message || String(e) };
    log('Schedule', `scheduled ${job.docType} stopped: ${error.message}`, 'warn');
  } finally {
    endSharedRun();
    closePrintTabs();
    clearInterval(pinger);
  }
  const counts = await hooks.finishTenderRun({ stopped: stoppedCode(result, error) });
  // the documents the hooks name, and what the job itself could not do (tenders, lists, messages, records):
  // tender-runner.js tenderRunOutcome decides done / partial / failed from both
  const outcome = error && error.code === 'SCHEDULE_TYPE_NOT_SUPPORTED'
    ? { outcome: 'failed', code: 'SCHEDULE_TYPE_NOT_SUPPORTED', permanent: true }
    : tenderRunOutcome({ result, error, counts, details: hooks.details(), range: scheduledSearch(job.docType, job.params).text });
  show(`Finished: ${counts.saved} saved, ${counts.skipped} already saved, ${outcome.result?.failed ?? counts.failed} failed.`);
  await send(MESSAGE_TYPES.SCHEDULE_RUNNER_DONE, { claimId, outcome }).catch(() => {});
}

main();
