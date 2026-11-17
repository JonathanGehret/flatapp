// Pure scheduling rules: when a chore is due next and whose turn it is.
// Dates are local calendar days as 'YYYY-MM-DD' strings.

const pad = (n) => String(n).padStart(2, '0');
export const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(toDate(s)) === s;
export const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return fmt(d); };
export const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / 864e5);

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

// ---------- points ----------

/** Days early within which a chore earns one point more. */
export const EARLY_WITHIN = 2;
/** Days late from which a chore earns one point less. */
export const LATE_AFTER = 3;

/**
 * Points for finishing a chore worth `base` on `date` when it was due on
 * `due`: one extra when done 1 to EARLY_WITHIN days before the due date, one
 * less (but never below 1) from LATE_AFTER days overdue. Otherwise the normal
 * points. The early window is short so that ticking a chore off twice in a
 * row earns no bonus.
 */
export function pointsFor(base, due, date) {
  const late = diffDays(date, due);
  if (late < 0 && late >= -EARLY_WITHIN) return base + 1;
  if (late >= LATE_AFTER) return Math.max(1, base - 1);
  return base;
}

// ---------- reminder preferences ----------
// Stored per member as `members.<id>.remind`; shared with the reminder job,
// which imports this file.

export const REMINDER_HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00 to 23:00
export const REMIND_AHEAD = [0, 1, 2, 3]; // days before the due date to start reminding
export const REMIND_DEFAULTS = Object.freeze({ hours: [8, 18], overdue_only: false, open: true, muted: [], ahead: 0, messages: true });

/** A member's reminder preferences, with defaults for anything not set. */
export function remindPrefs(member) {
  const r = member?.remind ?? {};
  return {
    hours: Array.isArray(r.hours) ? r.hours.filter((h) => REMINDER_HOURS.includes(h)) : [...REMIND_DEFAULTS.hours],
    overdue_only: Boolean(r.overdue_only),
    open: r.open ?? REMIND_DEFAULTS.open,
    muted: Array.isArray(r.muted) ? r.muted : [],
    ahead: REMIND_AHEAD.includes(r.ahead) ? r.ahead : REMIND_DEFAULTS.ahead,
    // Notifications flatmates send: reminders to do a chore, congratulations.
    messages: r.messages ?? REMIND_DEFAULTS.messages,
  };
}
