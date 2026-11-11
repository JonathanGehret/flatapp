// Decides who gets reminded about what. Pure, so it can be tested.

import { remindPrefs } from '../web/schedule.js';

/** Today's date ('YYYY-MM-DD') in the given IANA time zone. */
export function localDate(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10); // unknown zone: fall back to UTC
  }
}

/** The hour of the day (0-23) in the given IANA time zone. */
export function localHour(now, timeZone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  } catch {
    return now.getUTCHours();
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One reminder per active member who has something to be reminded of:
 * chores where it is their turn, plus chores without turns ("whoever gets to
 * it"), due today or earlier. Each member's preferences decide the hours they
 * hear from us, whether only overdue chores count, whether chores without
 * turns count, and which chores they muted.
 *
 * `hour` is the flat's local hour; null means "regardless of the hour" (a
 * manual run). Returns [{ memberId, title, body }].
 */
export function buildDigests(flat, today, hour = null) {
  const due = Object.entries(flat.chores ?? {})
    .map(([id, c]) => ({ id, ...c }))
    .filter((c) => c.next_due <= today)
    .sort((a, b) => a.next_due.localeCompare(b.next_due));
  const digests = [];
  for (const [memberId, member] of Object.entries(flat.members ?? {})) {
    if (!member.active) continue;
    const prefs = remindPrefs(member);
    if (hour != null && !prefs.hours.includes(hour)) continue;
    const wanted = due.filter((c) => !prefs.muted.includes(c.id) && (!prefs.overdue_only || c.next_due < today));
    const mine = wanted.filter((c) => c.assignee_id === memberId);
    const open = prefs.open ? wanted.filter((c) => c.assignee_id == null) : [];
    if (!mine.length && !open.length) continue;
    const overdue = mine.filter((c) => c.next_due < today).length;
    const title = mine.length
      ? `${plural(mine.length, 'chore')} waiting for you${overdue ? ` (${overdue} overdue)` : ''}`
      : `${plural(open.length, 'chore')} open for anyone`;
    const list = [...mine, ...open];
    const shown = list.slice(0, 4).map((c) => `${c.icon} ${c.title}`.trim());
    if (list.length > shown.length) shown.push(`and ${list.length - shown.length} more`);
    digests.push({ memberId, title, body: shown.join(', ') });
  }
  return digests;
}
