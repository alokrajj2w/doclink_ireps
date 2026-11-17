/**
 * The Recon Engine's shared-schedule API (Phase 1 scheduled downloads): schedules, today's
 * slots, the claim that lets exactly one DocLink run a slot, and the document reservations
 * that let each document be saved once per IREPS account. The contract is Appendix A of
 * schedular_implementation_plan.md.
 *
 * Every call goes to reconBaseUrl with the Recon sign-in (credentials: "include"), under one
 * deadline for headers and body (utils/http.js). Failures are ScheduleApiError with a
 * SCHEDULE_* / RECON_* code from utils/messages.js; the backend's own 404 / 409 codes
 * (CLAIM_LOST, ACCOUNT_BUSY, ...) come back as SCHEDULE_<code>, with the holder and lease
 * the backend reported.
 */

import { loadReconConfig, RECON_CONFIG, reconConfigProblem, manifestHostPermissions, apiErrorDetail } from "../recon-service.js";
import { fetchWithDeadline, DeadlineError } from "../../utils/http.js";

const REQUEST_TIMEOUT_MS = 30000;

/** Backend 404 / 409 codes DocLink acts on (anything else is reported as it is). */
export const SCHEDULE_CONFLICT = Object.freeze({
  SLOT_NOT_FOUND: "SCHEDULE_SLOT_NOT_FOUND",
  WRONG_ACCOUNT: "SCHEDULE_WRONG_ACCOUNT",
  NOT_DUE: "SCHEDULE_NOT_DUE",
  SLOT_DONE: "SCHEDULE_SLOT_DONE",
  SLOT_TAKEN: "SCHEDULE_SLOT_TAKEN",
  ACCOUNT_BUSY: "SCHEDULE_ACCOUNT_BUSY",
  CLAIM_LOST: "SCHEDULE_CLAIM_LOST",
  SCHEDULE_EXISTS: "SCHEDULE_EXISTS",
  SCHEDULE_NOT_FOUND: "SCHEDULE_NOT_FOUND"
});

export class ScheduleApiError extends Error {
  /**
   * @param {string} code
   * @param {{ status?: number|null, detail?: string, holder?: { user_id: number, name: string }|null, leaseUntil?: string|null, docType?: string|null }} [info]
   */
  constructor(code, { status = null, detail = "", holder = null, leaseUntil = null, docType = null } = {}) {
    super(detail || code);
    this.name = "ScheduleApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.holder = holder;
    this.leaseUntil = leaseUntil;
    this.docType = docType;
  }
}

function conflictFrom(response, body) {
  const d = body && body.detail && typeof body.detail === "object" ? body.detail : {};
  const backendCode = typeof d.error === "string" ? d.error : "";
  const code = SCHEDULE_CONFLICT[backendCode] || (backendCode ? `SCHEDULE_${backendCode}` : "SCHEDULE_BACKEND_UNAVAILABLE");
  return new ScheduleApiError(code, {
    status: response.status,
    detail: apiErrorDetail(body) || backendCode,
    holder: d.holder || null,
    leaseUntil: d.lease_until || null,
    docType: d.doc_type || null
  });
}

/**
 * The API, bound to its transport. Tests pass `fetch` (and `baseUrl` / `hostPermissions`);
 * the extension uses the configured Recon Engine.
 * @param {{ fetch?: Function, baseUrl?: string, hostPermissions?: string[], timeoutMs?: number }} [deps]
 */
export function createScheduleApi(deps = {}) {
  async function request(method, path, body) {
    let baseUrl = deps.baseUrl;
    if (!baseUrl) {
      await loadReconConfig();
      baseUrl = RECON_CONFIG.baseUrl;
    }
    const problem = reconConfigProblem(baseUrl, deps.hostPermissions || manifestHostPermissions(), path.split("?")[0]);
    if (problem) throw new ScheduleApiError("RECON_NOT_CONFIGURED", { detail: problem });
    const init = body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    let response;
    let answer;
    try {
      ({ response, body: answer } = await fetchWithDeadline(`${baseUrl}${path}`, { ...init, credentials: "include" }, { timeoutMs: deps.timeoutMs || REQUEST_TIMEOUT_MS, fetch: deps.fetch }));
    } catch (error) {
      const detail = error instanceof DeadlineError ? error.message : `could not reach ${new URL(baseUrl).origin}`;
      throw new ScheduleApiError("SCHEDULE_BACKEND_UNAVAILABLE", { detail });
    }
    if (response.status === 401) throw new ScheduleApiError("RECON_AUTH_REQUIRED", { status: 401 });
    if (response.status === 403) throw new ScheduleApiError("SCHEDULE_NO_PERMISSION", { status: 403, detail: apiErrorDetail(answer) || "not allowed" });
    if (response.status === 400 || response.status === 422) throw new ScheduleApiError("SCHEDULE_INVALID", { status: response.status, detail: apiErrorDetail(answer) || "the request was refused" });
    if (response.status === 404 || response.status === 409) throw conflictFrom(response, answer);
    if (response.status === 204) return {};
    if (!response.ok || !answer) throw new ScheduleApiError("SCHEDULE_BACKEND_UNAVAILABLE", { status: response.status, detail: apiErrorDetail(answer) || `HTTP ${response.status}` });
    return answer;
  }

  const query = (account, types) => {
    const q = new URLSearchParams({ account: String(account) });
    if (types && types.length) q.set("types", types.join(","));
    return q.toString();
  };

  return {
    /** Open slots of the account (only `types`), what runs now, and when to look again. */
    due: (account, types) => request("GET", `/api/doclink/schedule/due?${query(account, types)}`),
    /** Today's slots and the account's schedules, for the panel. */
    today: (account, types) => request("GET", `/api/doclink/schedule/today?${query(account, types)}`),
    claim: ({ slotId, claimId, account }) => request("POST", "/api/doclink/schedule/claim", { slot_id: slotId, claim_id: claimId, ireps_account_id: String(account) }),
    heartbeat: (claimId) => request("POST", "/api/doclink/schedule/heartbeat", { claim_id: claimId }),
    finish: ({ claimId, outcome, code = null, countsAsAttempt = true, permanent = false, result = null }) =>
      request("POST", "/api/doclink/schedule/finish", { claim_id: claimId, outcome, code, counts_as_attempt: countsAsAttempt, permanent, result }),
    reserve: ({ claimId, account, destination, keys }) => request("POST", "/api/doclink/documents/reserve", { claim_id: claimId, ireps_account_id: String(account), destination, keys }),
    complete: ({ claimId, done = [], failed = [] }) => request("POST", "/api/doclink/documents/complete", { claim_id: claimId, done, failed }),
    listSchedules: (account) => request("GET", `/api/doclink/schedules?${new URLSearchParams({ account: String(account) })}`),
    createSchedule: (schedule) => request("POST", "/api/doclink/schedules", schedule),
    updateSchedule: (id, changes) => request("PUT", `/api/doclink/schedules/${encodeURIComponent(id)}`, changes),
    deleteSchedule: (id) => request("DELETE", `/api/doclink/schedules/${encodeURIComponent(id)}`)
  };
}
