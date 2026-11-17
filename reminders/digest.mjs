// Decides who gets reminded about what. Pure, so it can be tested.

import { remindPrefs, addDays, diffDays } from '../web/schedule.js';

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

/** Friendly closing lines; one is added to each reminder when `cheer` is given. */
export const CHEERS = [
  'You’ve got this 💪',
  'Your flatmates will thank you ✨',
  'Quick win, then done 🙌',
  'A tidy flat is a happy flat 🏡',
  'Every chore counts towards this month’s prize 🏆',
  'Small steps, shiny flat 🌟',
];

const soon = (days) => (days === 1 ? 'tomorrow' : `in ${days} days`);

/**
 * One reminder per active member who has something to be reminded of:
 * chores where it is their turn, plus chores without turns ("whoever gets to
 * it"), due today or earlier, or within the next `ahead` days if they asked
 * for an early warning. Each member's preferences decide the hours they hear
 * from us, whether only overdue chores count, whether chores without turns
 * count, and which chores they muted.
 *
 * `hour` is the flat's local hour; null means "regardless of the hour" (a
 * manual run). `cheer`, if given, picks a closing line from CHEERS
 * (e.g. `(list) => list[Math.floor(Math.random() * list.length)]`).
 * Returns [{ memberId, title, body }].
 */
export function buildDigests(flat, today, hour = null, cheer = null) {
  const chores = Object.entries(flat.chores ?? {})
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => a.next_due.localeCompare(b.next_due));
  const digests = [];
  for (const [memberId, member] of Object.entries(flat.members ?? {})) {
    if (!member.active) continue;
    const prefs = remindPrefs(member);
    if (hour != null && !prefs.hours.includes(hour)) continue;
    const last = prefs.overdue_only ? addDays(today, -1) : addDays(today, prefs.ahead);
    const wanted = chores.filter((c) => !prefs.muted.includes(c.id) && c.next_due <= last);
    const forMe = wanted.filter((c) => c.assignee_id === memberId);
    const open = prefs.open ? wanted.filter((c) => c.assignee_id == null) : [];
    const mine = forMe.filter((c) => c.next_due <= today);
    const openNow = open.filter((c) => c.next_due <= today);
    const list = [...forMe, ...open];
    if (!list.length) continue;
    const overdue = mine.filter((c) => c.next_due < today).length;
    let title;
    if (mine.length) title = `${plural(mine.length, 'chore')} waiting for you${overdue ? ` (${overdue} overdue)` : ''}`;
    else if (openNow.length) title = `${plural(openNow.length, 'chore')} open for anyone`;
    else title = `Coming up: ${plural(list.length, 'chore')}`;
    const label = (c) => {
      const days = diffDays(c.next_due, today);
      return `${c.icon ?? ''} ${c.title}`.trim() + (days > 0 ? ` (${soon(days)})` : '');
    };
    const shown = list.slice(0, 4).map(label);
    if (list.length > shown.length) shown.push(`and ${list.length - shown.length} more`);
    const body = shown.join(', ') + (cheer ? `\n${cheer(CHEERS)}` : '');
    digests.push({ memberId, title, body });
  }
  return digests;
}

/** Messages older than this are dropped instead of sent. */
export const OUTBOX_MAX_AGE = 24 * 3600 * 1000;

/**
 * Who gets a message a flatmate sent (a reminder to do a chore, a
 * congratulation): its recipients who are still in the flat and have not
 * switched off messages from flatmates. Nobody once it is too old.
 */
export function messageTargets(flat, message, now) {
  if (!(now - message.at < OUTBOX_MAX_AGE)) return [];
  return (message.to ?? []).filter((id) => {
    const member = flat.members?.[id];
    return member?.active && remindPrefs(member).messages;
  });
}
