/**
 * Settings of the "Save to: ECM / S3" upload of IC, PO, MA and tender documents
 * (services/ecm-service.js), read from config.json and config.local.json.
 *
 *   ecmBackendAws  true  -> through the Recon Engine's ECM gateway (services/ecm-service.js)
 *                  false -> straight to the ECM (Nuxeo) from DocLink (services/ecm-direct.js),
 *                           for local testing
 *   ecm.env        TEST | PROD: which ECM folders (services/ecm-catalog.js)
 *   ecm.domain     the ECM origin, e.g. http://wctsrvecmtstsn1.wabtec.com:8080 (it must be
 *                  in manifest.json host_permissions)
 *   ecm.clientId / ecm.clientSecret   the ECM's client-credentials pair (direct mode only)
 *   ecm.timeoutMs  per request
 *
 * config.local.json (gitignored, never packaged by scripts/build.mjs) has the same shape
 * and overrides config.json: a top-level key replaces config.json's, the ecm object is
 * merged key by key (utils/config.js). That is where the real client id / secret go. The secret is never
 * logged.
 */

import { logger } from "../utils/logger.js";
import { compileMatchPatterns } from "../utils/url-scope.js";
import { readConfigFiles } from "../utils/config.js";

export const ECM_ENV = Object.freeze({ TEST: "TEST", PROD: "PROD" });

const DEFAULT_TIMEOUT_MS = 120000;

let current = settingsFrom({});
let configLoaded = false;

/** Live view of the ECM settings; mutable only through loadEcmConfig() / applyEcmConfig(). */
export const ECM_CONFIG = Object.freeze({
  get backendAws() {
    return current.backendAws;
  },
  get env() {
    return current.env;
  },
  get domain() {
    return current.domain;
  },
  get clientId() {
    return current.clientId;
  },
  get clientSecret() {
    return current.clientSecret;
  },
  get timeoutMs() {
    return current.timeoutMs;
  }
});

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function settingsFrom(config) {
  const c = config && typeof config === "object" ? config : {};
  const e = c.ecm && typeof c.ecm === "object" ? c.ecm : {};
  const env = text(e.env).toUpperCase();
  const timeout = Number(e.timeoutMs);
  return Object.freeze({
    // anything but an explicit true is direct mode
    backendAws: c.ecmBackendAws === true,
    env: env === ECM_ENV.PROD ? ECM_ENV.PROD : ECM_ENV.TEST,
    domain: text(e.domain).replace(/\/+$/, ""),
    clientId: text(e.clientId),
    clientSecret: text(e.clientSecret),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS
  });
}

/**
 * Apply ECM settings from a parsed (already merged) config object. Also used by the
 * tests, which have no extension context to read the files from.
 * @param {{ ecmBackendAws?: boolean, ecm?: object }} config
 */
export function applyEcmConfig(config) {
  current = settingsFrom(config);
  configLoaded = true;
  return ECM_CONFIG;
}

/**
 * Read the ECM settings from config.json and config.local.json. A no-op after the first
 * load unless `force` is passed. On any error the current settings are kept.
 * @param {{ force?: boolean }} [options]
 */
export async function loadEcmConfig({ force = false } = {}) {
  if (configLoaded && !force) return ECM_CONFIG;
  try {
    const files = await readConfigFiles();
    const local = files && files.local;
    if (files) applyEcmConfig(files.config);
    // which file the client id / secret come from (never their values): config.local.json
    // wins, so its placeholders hide real values put in config.json by mistake
    const fromLocal = Boolean(local && local.ecm && (local.ecm.clientId || local.ecm.clientSecret));
    logger.info(`ECM config loaded: ${current.backendAws ? "through the Recon Engine gateway" : `direct to ${current.domain || "(no ecm.domain)"} (${current.env})`}`, {
      localOverrides: Boolean(local),
      credentials: current.clientId && current.clientSecret ? (fromLocal ? "config.local.json" : "config.json") : "missing"
    });
  } finally {
    configLoaded = true;
  }
  return ECM_CONFIG;
}

/** True when ECM documents go straight to the ECM (Nuxeo), not through the Recon Engine. */
export function isDirectEcm() {
  return !current.backendAws;
}

/**
 * Why the ECM cannot be called directly, or "" when it can: ecm.domain must be set, valid
 * and covered by host_permissions, and both client credentials must be set.
 */
export function ecmDirectProblem(hostPermissions) {
  const { domain, clientId, clientSecret } = current;
  if (!domain) return "ecm.domain is not set in config.json";
  try {
    new URL(domain);
  } catch {
    return `ecm.domain "${domain}" is not a valid URL`;
  }
  if (!clientId || !clientSecret) return "ecm.clientId / ecm.clientSecret are not set (put them in config.local.json)";
  if (!compileMatchPatterns(hostPermissions)(`${domain}/nuxeo/api/v1`)) return `${new URL(domain).origin} is missing from manifest.json host_permissions`;
  return "";
}
