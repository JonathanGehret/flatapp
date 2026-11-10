// Pure scheduling rules: when a chore is due next and whose turn it is.
// Dates are local calendar days as 'YYYY-MM-DD' strings.

const pad = (n) => String(n).padStart(2, '0');
export const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(toDate(s)) === s;

/**
 * The next due date for a chore completed on `from`.
 * Month intervals clamp to the end of shorter months (Jan 31 + 1 month = Feb 28/29).
 */
export function nextDue(from, n, unit) {
  const d = toDate(from);
  if (unit === 'day') d.setDate(d.getDate() + n);
  else if (unit === 'week') d.setDate(d.getDate() + n * 7);
  else if (unit === 'month') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else throw new Error('Invalid interval');
  return fmt(d);
}

/**
 * Who comes after `current` in the rotation. Nobody if the rotation is empty;
 * the first person if `current` is not part of it.
 */
export function nextInRotation(rotation, current) {
  if (!rotation.length) return null;
  const i = rotation.indexOf(current);
  return i < 0 ? rotation[0] : rotation[(i + 1) % rotation.length];
}
