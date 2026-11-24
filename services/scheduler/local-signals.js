/**
 * What this browser knows locally before the scheduler asks anyone (plan section 8.4):
 *   - when an IREPS page last finished loading here (the user is active on IREPS);
 *   - when the winner's IREPS check last failed here (do not claim again until a new page loads);
 *   - the last verified IREPS account (833, 60828, ...), so the backend can be asked what is due
 *     without loading anything from IREPS;
 *   - the tabs DocLink opened itself (the print tabs of tender/tender-print.js, the tender runner tab):
 *     a page loading there is DocLink's own work, never a sign that the user is active on IREPS.
 * Only timestamps, tab ids and the account id are kept: never a URL, page content, cookie or token.
 * Activity and the own tabs live in chrome.storage.session (gone when Chrome closes, kept when the
 * worker restarts); the account in chrome.storage.local.
 */

import { SESSION_KEYS, STORAGE_KEYS } from "../../utils/messages.js";
import { logger } from "../../utils/logger.js";

/** IREPS logs a user out after about 5 idle minutes: a page load older than this says nothing. */
export const IREPS_ACTIVITY_MS = 4 * 60 * 1000;
/** Own tabs remembered at most (each is forgotten when it closes; a long Chrome session never grows the list). */
const OWN_TABS_MAX = 200;

/**
 * @param {{ session?: chrome.storage.StorageArea, local?: chrome.storage.StorageArea, now?: () => number }} [deps]
 */
export function createLocalSignals(deps = {}) {
  const session = deps.session || chrome.storage.session;
  const local = deps.local || chrome.storage.local;
  const now = deps.now || (() => Date.now());

  async function read(area, key) {
    try {
      const stored = await area.get(key);
      return stored ? stored[key] : undefined;
    } catch (error) {
      logger.debug(`Scheduler: could not read ${key}`, error);
      return undefined;
    }
  }

  async function write(area, key, value) {
    try {
      await area.set({ [key]: value });
    } catch (error) {
      logger.debug(`Scheduler: could not store ${key}`, error);
    }
  }

  async function signals() {
    const saved = await read(session, SESSION_KEYS.SCHEDULER_SIGNALS);
    return saved && typeof saved === "object" ? saved : {};
  }

  /** DocLink's own tab ids: read once from the session, then kept here; every change is stored after the one before. */
  let ownTabs = null;
  let ownTabsChange = Promise.resolve();
  async function ownTabSet() {
    if (!ownTabs) {
      const saved = await read(session, SESSION_KEYS.SCHEDULER_OWN_TABS);
      ownTabs = ownTabs || new Set(Array.isArray(saved) ? saved.filter(Number.isInteger) : []);
    }
    return ownTabs;
  }
  function changeOwnTabs(change) {
    ownTabsChange = ownTabsChange.then(async () => {
      const set = await ownTabSet();
      if (!change(set)) return;
      await write(session, SESSION_KEYS.SCHEDULER_OWN_TABS, [...set].slice(-OWN_TABS_MAX));
    });
    return ownTabsChange;
  }

  return {
    /** An IREPS page (not the login page) finished loading in this browser. */
    async recordIrepsActivity() {
      await write(session, SESSION_KEYS.SCHEDULER_SIGNALS, { ...(await signals()), irepsActivityAt: now() });
    },
    /** This DocLink won a claim but IREPS said "not logged in" (or another account). */
    async recordIrepsCheckFailed() {
      await write(session, SESSION_KEYS.SCHEDULER_SIGNALS, { ...(await signals()), irepsFailedAt: now() });
    },
    /**
     * May this DocLink try a claim? Only right after IREPS activity, and not again after a
     * failed IREPS check until a newer page load.
     */
    async irepsReady() {
      const s = await signals();
      const at = Number(s.irepsActivityAt) || 0;
      if (!at || now() - at > IREPS_ACTIVITY_MS) return false;
      return !(Number(s.irepsFailedAt) >= at);
    },
    /**
     * Until when an IREPS page load need not ask the backend: nothing was due and nothing ran
     * at the last look, and the backend's next check is later (0 = ask at once).
     */
    async setQuietUntil(ms) {
      await write(session, SESSION_KEYS.SCHEDULER_SIGNALS, { ...(await signals()), quietUntil: Number(ms) || 0 });
    },
    async quietUntil() {
      return Number((await signals()).quietUntil) || 0;
    },
    async recordAccount(irepsAccountId) {
      if (!irepsAccountId) return;
      await write(local, STORAGE_KEYS.SCHEDULER_ACCOUNT, { id: String(irepsAccountId), at: now() });
    },
    /** The last verified IREPS account id, or null. */
    async account() {
      const saved = await read(local, STORAGE_KEYS.SCHEDULER_ACCOUNT);
      return saved && saved.id ? String(saved.id) : null;
    },
    /** A tab DocLink opened itself (a print tab, the tender runner tab): its page loads are DocLink's own work. */
    recordOwnTab(tabId) {
      if (!Number.isInteger(tabId)) return ownTabsChange;
      return changeOwnTabs((set) => {
        if (set.has(tabId)) return false;
        set.add(tabId);
        return true;
      });
    },
    /** A tab closed: no longer one to tell apart. */
    forgetOwnTab(tabId) {
      return changeOwnTabs((set) => set.delete(tabId));
    },
    /** Whether `tab` (a chrome.tabs.Tab) is one DocLink opened, or was opened from one (a popup of a print tab). */
    async isOwnTab(tab) {
      if (!tab) return false;
      await ownTabsChange;
      const set = await ownTabSet();
      return set.has(tab.id) || (Number.isInteger(tab.openerTabId) && set.has(tab.openerTabId));
    }
  };
}
