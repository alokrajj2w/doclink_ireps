/**
 * Small DOM helpers shared by the side-panel views (popup/popup-*.js).
 */

/**
 * Replace a <select>'s options with IREPS's list ({ value, label }), keeping the current
 * choice when it is still offered and falling back to `fallbackValue` otherwise.
 * An empty or missing list leaves the select as it is; returns whether it was filled.
 */
export function fillSelect(select, options, fallbackValue) {
  if (!Array.isArray(options) || options.length === 0) return false;
  const current = select.value;
  select.replaceChildren();
  for (const o of options) {
    const option = document.createElement("option");
    option.value = o.value;
    option.textContent = o.label;
    select.append(option);
  }
  select.value = options.some((o) => o.value === current) ? current : fallbackValue;
  return true;
}
