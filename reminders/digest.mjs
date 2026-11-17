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

/**
 * "Needs doing now" flags: whoever flagged a chore wants it done soon, so the
 * person whose turn it is hears about it at the next run, whatever their
 * hours or mutes. Chores without turns go to everyone. The flagger is left
 * out. `sent` maps chore id to the flag time already announced, so each flag
 * is sent once. Returns [{ memberId, title, body, tag }].
 */
export function buildNudges(flat, sent = {}) {
  const members = flat.members ?? {};
  const nudges = [];
  for (const [id, c] of Object.entries(flat.chores ?? {})) {
    const flag = c.urgent;
    if (!flag?.at || sent[id] === flag.at) continue;
    const by = members[flag.by]?.name ?? 'A flatmate';
    const to = c.assignee_id
      ? [c.assignee_id]
      : Object.keys(members).filter((m) => members[m].active);
    for (const memberId of to) {
      if (memberId === flag.by || !members[memberId]?.active) continue;
      nudges.push({
        memberId,
        title: `${c.icon ?? ''} ${c.title}: needs doing now`.trim(),
        body: `${by}: ${flag.message || 'Could you take care of it soon?'}${c.assignee_id ? ' It’s your turn.' : ''}`,
        tag: `flatapp-now-${id}`,
      });
    }
  }
  return nudges;
}

/** The flags to remember as sent: every chore currently flagged. */
export const flagTimes = (flat) => Object.fromEntries(
  Object.entries(flat.chores ?? {}).filter(([, c]) => c.urgent?.at).map(([id, c]) => [id, c.urgent.at]),
);
