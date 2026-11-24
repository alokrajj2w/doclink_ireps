/**
 * The panel's Recon Engine sign-in (login 2; IREPS is login 1).
 *
 * With the download log on (config.json "downloadLog", services/download-log.js) every
 * download run needs it, Local or ECM / S3: downloads are recorded for the signed-in user.
 * Starting a run asks the Recon Engine who is signed in (GET /api/auth/me); when nobody is,
 * the "Sign in to Recon Engine" page covers the panel until the user signs in (password
 * or Okta) or cancels, and the run does not start. When the Recon Engine cannot be reached
 * at all (down, or no network path to it), as opposed to nobody being signed in, the page
 * also offers "Download without the Recon Engine": the log must never block a run, so that
 * run saves locally without the already-downloaded check, and its records wait in the
 * queue until the Recon Engine is back (services/download-log.js).
 *
 * With the log off only "Save to: ECM / S3" needs it (and, when config.json "ecmBackendAws"
 * is false, only for Bill Status, CRN and R-NOTE: ECM documents then go straight to the
 * ECM); there the page offers "Use Local instead". The RECON pill in the header shows the
 * result and opens the same page (with Sign out) on click.
 *
 * Nothing is stored here: the sign-in state is always the Recon Engine's answer, and the
 * password field is cleared as soon as it has been sent.
 */

import { describeError, MESSAGE_TYPES, TARGETS } from "../utils/messages.js";
import { SAVE_DESTINATION, RECON_CONFIG, loadReconConfig } from "../services/recon-service.js";
import { loadEcmConfig, isDirectEcm } from "../services/ecm-config.js";
import { loadDownloadLogConfig, isDownloadLogEnabled, setDownloadLogUser, flushDownloadLog } from "../services/download-log.js";
import { reconWhoAmI, reconSignIn, reconSignOut, reconOktaSignIn, reconProviders, oktaRedirectUri, ReconAuthError, RECON_AUTH_ERROR, RECON_SIGN_IN_EVENT } from "../services/recon-auth.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);

let el = null;
let ctx = null;
/** @type {{ signedIn: boolean, user?: object, reason?: string } | null} */
let status = null;
/** The pending ensureSignedIn() calls waiting for the page: { waiters: [{ resolve, allowOffline }], required, allowOffline } */
let waiting = null;

/** ensureReconSignedIn() answer when the Recon Engine is unreachable and the user chose to download without it. */
export const RECON_OFFLINE = "offline";

function setPill(state, text) {
  el.pill.dataset.state = state;
  el.pillText.textContent = text;
}

function renderPill() {
  el.pill.hidden = ctx.getDestination() !== SAVE_DESTINATION.RECON && !isDownloadLogEnabled();
  if (!status) setPill("checking", "Checking…");
  else if (status.signedIn) setPill("connected", status.user.name || status.user.email);
  else if (status.reason === "UNAVAILABLE") setPill("offline", "Unavailable");
  else setPill("login", "Sign in");
  el.pill.title = status && status.signedIn ? `Recon Engine: signed in as ${status.user.email}${status.user.role ? ` (${status.user.role})` : ""}. Click to sign out.` : isDownloadLogEnabled() ? "Recon Engine sign-in (needed to download: downloads are logged per user)" : "Recon Engine sign-in (for Save to: ECM / S3)";
}

function showError(described) {
  el.error.textContent = `${described.title}: ${described.message}`;
  el.error.hidden = false;
}

function hideError() {
  el.error.hidden = true;
  el.error.textContent = "";
}

function setBusy(busy) {
  el.btnSignIn.disabled = busy;
  el.btnOkta.disabled = busy;
  el.btnSignIn.classList.toggle("is-busy", busy);
}

async function refreshOkta() {
  await loadReconConfig();
  const redirect = oktaRedirectUri();
  el.oktaRedirect.textContent = redirect;
  el.oktaSetup.hidden = !RECON_CONFIG.okta.enabled || !redirect;
  if (!RECON_CONFIG.okta.enabled) {
    el.okta.hidden = true;
    return;
  }
  try {
    el.okta.hidden = !(await reconProviders()).okta;
  } catch {
    el.okta.hidden = true;
  }
}

/** Show the page. With someone signed in it only offers Sign out. */
function openPage() {
  hideError();
  const signedIn = Boolean(status && status.signedIn);
  el.user.hidden = !signedIn;
  el.user.textContent = signedIn ? `Signed in as ${status.user.name} (${status.user.email})` : "";
  el.form.hidden = signedIn;
  el.btnSignOut.hidden = !signedIn;
  // a run that needs the sign-in whatever Save to says can only be cancelled, not moved to Local
  const required = Boolean(waiting && waiting.required) || ctx.getDestination() !== SAVE_DESTINATION.RECON;
  el.btnUseLocal.textContent = signedIn ? "Back" : required ? "Cancel" : "Use Local instead";
  renderOfflineChoice();
  el.intro.textContent = isDownloadLogEnabled() ? INTRO_LOGGED : INTRO_ECM;
  if (!signedIn) refreshOkta();
  el.view.hidden = false;
  document.body.dataset.reconLogin = "on";
  if (!signedIn) (el.email.value ? el.password : el.email).focus();
}

/** "Download without the Recon Engine": only while it is unreachable and the waiting run allows it. */
function renderOfflineChoice() {
  el.btnOffline.hidden = !(waiting && waiting.allowOffline && status && !status.signedIn && status.reason === "UNAVAILABLE");
}

function closePage() {
  el.view.hidden = true;
  delete document.body.dataset.reconLogin;
  el.password.value = "";
}

/** Close the page and answer every waiting run: true (signed in), false, or RECON_OFFLINE (only to runs that allow it). */
function settle(answer) {
  closePage();
  if (waiting) {
    const { waiters } = waiting;
    waiting = null;
    for (const w of waiters) w.resolve(answer === RECON_OFFLINE && !w.allowOffline ? false : answer);
  }
}

/** The signed-in Recon user ({ id, email, name, roles, role, isAdmin }) as last checked, or null. */
export function currentReconUser() {
  return status && status.signedIn ? status.user : null;
}

/** Whether the Recon Engine could not be reached at the last check (down, or no network path), as opposed to nobody being signed in. */
export function reconUnreachable() {
  return Boolean(status && !status.signedIn && status.reason === "UNAVAILABLE");
}

/** Ask the Recon Engine who is signed in; never throws. */
export async function refreshReconStatus() {
  try {
    status = await reconWhoAmI();
    // the download log stamps this user on the records this panel queues (a definite answer only)
    setDownloadLogUser(status.signedIn ? status.user : null);
  } catch (error) {
    status = { signedIn: false, reason: error instanceof ReconAuthError && error.code === RECON_AUTH_ERROR.NOT_CONFIGURED ? "NOT_CONFIGURED" : "UNAVAILABLE" };
  }
  renderPill();
  if (el && !el.view.hidden) renderOfflineChoice();
  return status;
}

const INTRO_ECM = "Needed to save to ECM / S3. This is separate from your IREPS login and e-sign key: use your joulestowatts Recon Engine account or Okta.";
const INTRO_LOGGED = "Needed to download: DocLink records each download for the signed-in user and checks what you already downloaded. This is separate from your IREPS login and e-sign key: use your joulestowatts Recon Engine account or Okta.";

/**
 * Before a run: resolves true when someone is signed in to the Recon Engine (asking on the
 * sign-in page if needed), false when the user cancelled or chose Local. Without `always`
 * it is only asked under Save to: ECM / S3 (always true while Save to is Local); with it
 * (the download log) whatever Save to says. With `allowOffline` (a download run under the
 * log) it can also resolve RECON_OFFLINE: the Recon Engine is unreachable and the user chose
 * to download without it.
 * @param {{ always?: boolean, allowOffline?: boolean }} [options]
 * @returns {Promise<boolean|string>}
 */
export async function ensureReconSignedIn({ always = false, allowOffline = false } = {}) {
  if (!always && ctx.getDestination() !== SAVE_DESTINATION.RECON) return true;
  const current = await refreshReconStatus();
  if (current.signedIn) return true;
  if (waiting) {
    waiting.required = waiting.required || always;
    return new Promise((resolve) => {
      waiting.waiters.push({ resolve, allowOffline });
      // the offline choice is offered only while every waiting run accepts it
      waiting.allowOffline = waiting.allowOffline && allowOffline;
      renderOfflineChoice();
    });
  }
  return new Promise((resolve) => {
    waiting = { waiters: [{ resolve, allowOffline }], required: always, allowOffline };
    openPage();
    if (current.reason === "UNAVAILABLE") showError(describeError("RECON_SIGNIN_UNAVAILABLE", { detail: "check that it is running" }));
    if (current.reason === "NOT_CONFIGURED") showError(describeError("RECON_NOT_CONFIGURED", { detail: "reconBaseUrl or host_permissions" }));
  });
}

/** A scheduled download that waited for the Recon sign-in may start now (background/scheduler-job.js). */
function nudgeScheduler() {
  chrome.runtime.sendMessage({ target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.SCHEDULE_NUDGE, reason: "recon sign-in" }).catch(() => {});
}

async function onSignIn(event) {
  event.preventDefault();
  hideError();
  setBusy(true);
  try {
    const user = await reconSignIn(el.email.value, el.password.value);
    status = { signedIn: true, user };
    setDownloadLogUser(user);
    nudgeScheduler();
    renderPill();
    settle(true);
  } catch (error) {
    showError(describeError(error.code || "UNKNOWN", { detail: error.detail }));
  } finally {
    el.password.value = "";
    setBusy(false);
  }
}

async function onOkta() {
  hideError();
  setBusy(true);
  try {
    const user = await reconOktaSignIn();
    status = { signedIn: true, user };
    setDownloadLogUser(user);
    nudgeScheduler();
    renderPill();
    settle(true);
  } catch (error) {
    logger.warn("Okta sign-in did not complete", { code: error.code });
    showError(describeError(error.code || "UNKNOWN", { detail: error.detail }));
  } finally {
    setBusy(false);
  }
}

async function onSignOut() {
  // records this panel queued go out under the user who saved them, before the session ends
  await flushDownloadLog();
  try {
    await reconSignOut();
  } catch (error) {
    showError(describeError(error.code || "UNKNOWN", { detail: error.detail }));
    return;
  }
  status = { signedIn: false, reason: "NOT_AUTHENTICATED" };
  setDownloadLogUser(null);
  renderPill();
  openPage();
}

function onUseLocal() {
  const signedIn = Boolean(status && status.signedIn);
  // "Use Local instead" (an ECM / S3 run without the log); "Cancel" leaves Save to alone
  if (!signedIn && !(waiting && waiting.required) && ctx.getDestination() === SAVE_DESTINATION.RECON) ctx.setDestination(SAVE_DESTINATION.LOCAL);
  renderPill();
  settle(signedIn);
}

/**
 * Called when the Save to switch changes: ECM / S3 checks (and asks for) the sign-in.
 * When ECM documents go straight to the ECM (config.json "ecmBackendAws": false) only the
 * S3 runs need it, so it is only checked here and asked for when such a run starts.
 */
export async function onReconDestinationChange() {
  renderPill();
  if (await loadDownloadLogConfig()) {
    // every run asks for the sign-in when it starts; here only the pill is brought up to date
    await refreshReconStatus();
  } else if (ctx.getDestination() === SAVE_DESTINATION.RECON) {
    await loadEcmConfig();
    if (isDirectEcm()) await refreshReconStatus();
    else await ensureReconSignedIn();
  } else if (!el.view.hidden && !(waiting && waiting.required)) settle(false);
}

/**
 * The sign-in page the user asked for (the RECON pill, a "Sign in to Recon" button): it opens whatever Save
 * to says, Local too (7.6). Under ECM / S3 it offers "Use Local instead" as before; under Local, Cancel.
 */
function askSignIn() {
  return ensureReconSignedIn({ always: ctx.getDestination() !== SAVE_DESTINATION.RECON });
}

/** Open the sign-in page from an error panel ("Sign in to Recon"). */
export async function openReconSignIn() {
  await refreshReconStatus();
  if (status.signedIn) openPage();
  else await askSignIn();
}

/**
 * @param {{ getDestination: () => string, setDestination: (value: string) => void }} context
 */
export function initReconAuth(context) {
  ctx = context;
  el = {
    pill: $("recon-connection"),
    pillText: $("recon-connection-text"),
    view: $("view-recon-login"),
    user: $("recon-user"),
    intro: $("recon-login-intro"),
    form: $("recon-login-form"),
    email: $("recon-email"),
    password: $("recon-password"),
    btnSignIn: $("btn-recon-sign-in"),
    okta: $("recon-okta"),
    btnOkta: $("btn-recon-okta"),
    error: $("recon-login-error"),
    btnUseLocal: $("btn-recon-use-local"),
    btnOffline: $("btn-recon-offline"),
    btnSignOut: $("btn-recon-sign-out"),
    oktaSetup: $("recon-okta-setup"),
    oktaRedirect: $("recon-okta-redirect"),
    btnCopyRedirect: $("btn-recon-copy-redirect")
  };
  el.form.addEventListener("submit", onSignIn);
  el.btnOkta.addEventListener("click", onOkta);
  el.btnUseLocal.addEventListener("click", onUseLocal);
  el.btnOffline.addEventListener("click", () => {
    logger.warn("Recon Engine unreachable: the user chose to download without it (saved locally; download records queued until it is back)");
    settle(RECON_OFFLINE);
  });
  el.btnSignOut.addEventListener("click", onSignOut);
  el.btnCopyRedirect.addEventListener("click", () => navigator.clipboard.writeText(el.oktaRedirect.textContent).catch(() => {}));
  // The tender view (a separate script) asks through this event before an ECM run.
  document.addEventListener(RECON_SIGN_IN_EVENT, (event) => {
    event.preventDefault();
    ensureReconSignedIn({ always: Boolean(event.detail.always), allowOffline: Boolean(event.detail.allowOffline) }).then(event.detail.resolve);
  });
  el.pill.addEventListener("click", () => {
    if (status && status.signedIn) openPage();
    else askSignIn();
  });
  renderPill();
}
