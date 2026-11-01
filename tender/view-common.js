// What the two side-panel views of tender/ share: the IREPS account panel, "Copy diagnostics",
// re-checking the account when the panel comes back into view, and stepping aside when
// DocLink's "go to IREPS" gate takes over. Download Tender Documents (tender-ui.js) uses the
// ids acc-*, Correspondence (pending-ui.js) the ids pc-acc-*.
import { SESSION_MSG, getLogTail, log } from './tender-core.js';
import { getActiveIrepsAccountContext, ACCOUNT_UNVERIFIED_MSG } from './tender-account.js';

const $ = (id) => document.getElementById(id);

/** Render a detected (or failed) account context into `<prefix>acc-*`. Every value shown is from IREPS. */
export function renderAccountPanel(prefix, a) {
  const ok = !!(a && a.authenticated && a.verified);
  $(`${prefix}acc-connection`).textContent = a?.authenticated ? 'Connected' : 'Not connected';
  $(`${prefix}acc-company`).textContent = ok || a?.companyName ? a.companyName : '—';
  $(`${prefix}acc-unit`).textContent = ok ? a.operatingUnit || 'Not stated' : '—';
  $(`${prefix}acc-id`).textContent = ok || a?.irepsAccountId ? a.irepsAccountId : '—';
  $(`${prefix}acc-status`).textContent = ok ? 'Verified' : 'Account not verified';
  $(`${prefix}acc-status`).className = ok ? 'tender-ok' : 'tender-bad';
  const w = $(`${prefix}acc-warning`);
  w.textContent = ok ? '' : a && !a.authenticated ? SESSION_MSG : ACCOUNT_UNVERIFIED_MSG;
  w.hidden = ok;
}

/** Detect the active IREPS account and show it (a failed check shows "not connected"). */
export async function refreshAccountPanel(prefix) {
  $(`${prefix}acc-connection`).textContent = 'Checking…';
  $(`${prefix}acc-status`).textContent = 'Checking…';
  try {
    renderAccountPanel(prefix, await getActiveIrepsAccountContext());
  } catch (e) {
    log('Account', `check failed: ${e.message}`, 'error');
    renderAccountPanel(prefix, null);
  }
}

/** "Copy diagnostics": the recent (already redacted) tender log to the clipboard. */
export function wireCopyDiagnostics(button) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getLogTail() || '(no log yet)');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = 'Copy diagnostics'), 1500);
  });
}

/**
 * The user may switch IREPS accounts in another tab: re-detect whenever the panel regains
 * focus (while the view is open and idle). And if the gate takes over, hide the view.
 */
export function wireViewLifecycle({ view, gate, isRunning, refresh }) {
  const refreshIfVisible = () => !view.hidden && !isRunning() && refresh();
  window.addEventListener('focus', refreshIfVisible);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshIfVisible());
  new MutationObserver(() => {
    if (!gate.hidden) view.hidden = true;
  }).observe(gate, { attributes: true, attributeFilter: ['hidden'] });
}
