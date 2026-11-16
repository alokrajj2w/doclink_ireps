// One tender / correspondence run per side panel. Both views (tender-ui.js, pending-ui.js)
// drive IREPS from this page, the same session and the same print tab, so a second run
// must wait. The lock lives on the DOM, not in module state, so it holds even if the two
// views were ever loaded as separate bundles.

const KEY = 'doclinkPanelRun';

/** The name of the run holding the panel, or null. */
export const activePanelRun = () => document.body.dataset[KEY] || null;

/** True when a run other than `name` holds the panel. */
export const isPanelBusy = (name) => { const h = activePanelRun(); return Boolean(h && h !== name); };

/** Text for a run that has to wait because another run holds the panel. */
export const PANEL_BUSY_MSG = 'Another tender / correspondence download is still running in this panel. Wait for it to finish, then try again.';

/** Take the panel for `name`; false when another run holds it. */
export function claimPanelRun(name) {
  const holder = activePanelRun();
  if (holder && holder !== name) return false;
  document.body.dataset[KEY] = name;
  return true;
}

/** Give the panel back (only the holder can). */
export function releasePanelRun(name) {
  if (activePanelRun() === name) delete document.body.dataset[KEY];
}
