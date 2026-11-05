/**
 * The panel's Recon Engine sign-in (login 2; IREPS is login 1).
 *
 * With the download log on (config.json "downloadLog", services/download-log.js) every
 * download run needs it, Local or ECM / S3: downloads are recorded for the signed-in user.
 * Starting a run asks the Recon Engine who is signed in (GET /api/auth/me); when nobody is,
 * the "Sign in to Recon Engine" page covers the panel until the user signs in (password
 * or Okta) or cancels, and the run does not start.
 *
 * With the log off only "Save to: ECM / S3" needs it (and, when config.json "ecmBackendAws"
 * is false, only for Bill Status, CRN and R-NOTE: ECM documents then go straight to the
 * ECM); there the page offers "Use Local instead". The RECON pill in the header shows the
 * result and opens the same page (with Sign out) on click.
 *
 * Nothing is stored here: the sign-in state is always the Recon Engine's answer, and the
 * password field is cleared as soon as it has been sent.
 */

import { describeError } from "../utils/messages.js";
import { SAVE_DESTINATION, RECON_CONFIG, loadReconConfig } from "../services/recon-service.js";
import { loadEcmConfig, isDirectEcm } from "../services/ecm-config.js";
import { loadDownloadLogConfig, isDownloadLogEnabled } from "../services/download-log.js";
import { reconWhoAmI, reconSignIn, reconSignOut, reconOktaSignIn, reconProviders, oktaRedirectUri, ReconAuthError, RECON_AUTH_ERROR, RECON_SIGN_IN_EVENT } from "../services/recon-auth.js";
import { logger } from "../utils/logger.js";

const $ = (id) => document.getElementById(id);

let el = null;
let ctx = null;
/** @type {{ signedIn: boolean, user?: object, reason?: string } | null} */
let status = null;
/** The pending ensureSignedIn() waiting for the page: { resolve, required } */
let waiting = null;

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
  el.intro.textContent = isDownloadLogEnabled() ? INTRO_LOGGED : INTRO_ECM;
  if (!signedIn) refreshOkta();
  el.view.hidden = false;
  document.body.dataset.reconLogin = "on";
  if (!signedIn) (el.email.value ? el.password : el.email).focus();
}

function closePage() {
  el.view.hidden = true;
  delete document.body.dataset.reconLogin;
  el.password.value = "";
}

function settle(signedIn) {
  closePage();
  if (waiting) {
    const { resolve } = waiting;
    waiting = null;
    resolve(signedIn);
  }
}

/** The signed-in Recon user ({ id, email, name, roles, role, isAdmin }) as last checked, or null. */
export function currentReconUser() {
  return status && status.signedIn ? status.user : null;
}

/** Ask the Recon Engine who is signed in; never throws. */
export async function refreshReconStatus() {
  try {
    status = await reconWhoAmI();
  } catch (error) {
    status = { signedIn: false, reason: error instanceof ReconAuthError && error.code === RECON_AUTH_ERROR.NOT_CONFIGURED ? "NOT_CONFIGURED" : "UNAVAILABLE" };
  }
  renderPill();
  return status;
}

const INTRO_ECM = "Needed to save to ECM / S3. This is separate from your IREPS login and e-sign key: use your joulestowatts Recon Engine account or Okta.";
const INTRO_LOGGED = "Needed to download: DocLink records each download for the signed-in user and checks what you already downloaded. This is separate from your IREPS login and e-sign key: use your joulestowatts Recon Engine account or Okta.";

/**
 * Before a run: resolves true when someone is signed in to the Recon Engine (asking on the
 * sign-in page if needed), false when the user cancelled or chose Local. Without `always`
 * it is only asked under Save to: ECM / S3 (always true while Save to is Local); with it
 * (the download log) whatever Save to says.
 * @param {{ always?: boolean }} [options]
 */
export async function ensureReconSignedIn({ always = false } = {}) {
  if (!always && ctx.getDestination() !== SAVE_DESTINATION.RECON) return true;
  const current = await refreshReconStatus();
  if (current.signedIn) return true;
  if (waiting) {
    waiting.required = waiting.required || always;
    return new Promise((resolve) => waiting.also.push(resolve));
  }
  return new Promise((resolve) => {
    const also = [];
    waiting = {
      also,
      required: always,
      resolve: (value) => {
        resolve(value);
        for (const r of also) r(value);
      }
    };
    openPage();
    if (current.reason === "UNAVAILABLE") showError(describeError("RECON_SIGNIN_UNAVAILABLE", { detail: "check that it is running" }));
    if (current.reason === "NOT_CONFIGURED") showError(describeError("RECON_NOT_CONFIGURED", { detail: "reconBaseUrl or host_permissions" }));
  });
}

async function onSignIn(event) {
  event.preventDefault();
  hideError();
  setBusy(true);
  try {
    const user = await reconSignIn(el.email.value, el.password.value);
    status = { signedIn: true, user };
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
  try {
    await reconSignOut();
  } catch (error) {
    showError(describeError(error.code || "UNKNOWN", { detail: error.detail }));
    return;
  }
  status = { signedIn: false, reason: "NOT_AUTHENTICATED" };
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

/** Open the sign-in page from an error panel ("Sign in to Recon"). */
export async function openReconSignIn() {
  await refreshReconStatus();
  if (status.signedIn) openPage();
  else await ensureReconSignedIn();
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
    btnSignOut: $("btn-recon-sign-out"),
    oktaSetup: $("recon-okta-setup"),
    oktaRedirect: $("recon-okta-redirect"),
    btnCopyRedirect: $("btn-recon-copy-redirect")
  };
  el.form.addEventListener("submit", onSignIn);
  el.btnOkta.addEventListener("click", onOkta);
  el.btnUseLocal.addEventListener("click", onUseLocal);
  el.btnSignOut.addEventListener("click", onSignOut);
  el.btnCopyRedirect.addEventListener("click", () => navigator.clipboard.writeText(el.oktaRedirect.textContent).catch(() => {}));
  // The tender view (a separate script) asks through this event before an ECM run.
  document.addEventListener(RECON_SIGN_IN_EVENT, (event) => {
    event.preventDefault();
    ensureReconSignedIn({ always: Boolean(event.detail.always) }).then(event.detail.resolve);
  });
  el.pill.addEventListener("click", () => {
    if (status && status.signedIn) openPage();
    else ensureReconSignedIn();
  });
  renderPill();
}
