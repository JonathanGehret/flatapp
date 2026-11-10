// Decides who gets reminded about what. Pure, so it can be tested.

/** Today's date ('YYYY-MM-DD') in the given IANA time zone. */
export function localDate(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10); // unknown zone: fall back to UTC
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One reminder per active member who has something due today or earlier:
 * chores where it is their turn, plus chores without turns ("whoever gets to it").
 * Returns [{ memberId, title, body }].
 */
export function buildDigests(flat, today) {
  const due = Object.values(flat.chores ?? {})
    .filter((c) => c.next_due <= today)
    .sort((a, b) => a.next_due.localeCompare(b.next_due));
  const digests = [];
  for (const [memberId, member] of Object.entries(flat.members ?? {})) {
    if (!member.active) continue;
    const mine = due.filter((c) => c.assignee_id === memberId);
    const open = due.filter((c) => c.assignee_id == null);
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
