import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigests, localDate, localHour } from './digest.mjs';

const chore = (title, assignee_id, next_due) => ({ title, icon: '🧹', assignee_id, next_due });
const flat = (remind = {}) => ({
  members: {
    mia: { name: 'Mia', active: true, remind: remind.mia },
    tom: { name: 'Tom', active: true, remind: remind.tom },
    old: { name: 'Old', active: false },
  },
  chores: {
    a: chore('Kitchen', 'mia', '2026-11-10'),
    b: chore('Bathroom', 'mia', '2026-11-08'),
    c: chore('Windows', 'mia', '2026-11-20'),
    d: chore('Trash', 'tom', '2026-11-11'),
    e: chore('Plants', null, '2026-11-09'),
    f: chore('Gone', 'old', '2026-11-01'),
  },
});
const forMember = (digests, id) => digests.find((d) => d.memberId === id);

test('reminds about due and overdue chores only', () => {
  const mia = forMember(buildDigests(flat(), '2026-11-10'), 'mia');
  assert.equal(mia.title, '2 chores waiting for you (1 overdue)');
  assert.equal(mia.body, '🧹 Bathroom, 🧹 Kitchen, 🧹 Plants');
});

test('chores without turns go to everyone; nothing due means no reminder', () => {
  const digests = buildDigests(flat(), '2026-11-10');
  assert.equal(forMember(digests, 'tom').title, '1 chore open for anyone');
  assert.equal(forMember(digests, 'old'), undefined);
  assert.deepEqual(buildDigests(flat(), '2026-10-01'), []);
});

test('default hours are 8 and 18; a manual run ignores the hour', () => {
  assert.equal(buildDigests(flat(), '2026-11-10', 8).length, 2);
  assert.equal(buildDigests(flat(), '2026-11-10', 18).length, 2);
  assert.equal(buildDigests(flat(), '2026-11-10', 12).length, 0);
  assert.equal(buildDigests(flat(), '2026-11-10', null).length, 2);
});

test('each member chooses their own hours', () => {
  const f = flat({ mia: { hours: [7] }, tom: { hours: [] } });
  assert.deepEqual(buildDigests(f, '2026-11-10', 7).map((d) => d.memberId), ['mia']);
  assert.deepEqual(buildDigests(f, '2026-11-10', 8), []);
});

test('overdue only', () => {
  const mia = forMember(buildDigests(flat({ mia: { overdue_only: true } }), '2026-11-10'), 'mia');
  assert.equal(mia.body, '🧹 Bathroom, 🧹 Plants');
});

test('chores without turns can be left out', () => {
  const f = flat({ mia: { open: false }, tom: { open: false } });
  assert.equal(forMember(buildDigests(f, '2026-11-10'), 'mia').body, '🧹 Bathroom, 🧹 Kitchen');
  assert.equal(forMember(buildDigests(f, '2026-11-10'), 'tom'), undefined);
});

test('muted chores are left out', () => {
  const mia = forMember(buildDigests(flat({ mia: { muted: ['b', 'e'] } }), '2026-11-10'), 'mia');
  assert.equal(mia.title, '1 chore waiting for you');
  assert.equal(mia.body, '🧹 Kitchen');
});

test('long lists are shortened', () => {
  const chores = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, chore(`C${i}`, 'mia', '2026-11-01')]));
  const [digest] = buildDigests({ members: { mia: { active: true } }, chores }, '2026-11-10');
  assert.ok(digest.body.endsWith('and 2 more'));
});

test('local date and hour follow the flat time zone', () => {
  const now = new Date('2026-11-10T23:30:00Z');
  assert.equal(localDate(now, 'Europe/Berlin'), '2026-11-11');
  assert.equal(localDate(now, 'America/Los_Angeles'), '2026-11-10');
  assert.equal(localDate(now, 'Not/AZone'), '2026-11-10');
  assert.equal(localHour(new Date('2026-11-10T07:05:00Z'), 'Europe/Berlin'), 8); // winter, UTC+1
  assert.equal(localHour(new Date('2026-07-10T06:05:00Z'), 'Europe/Berlin'), 8); // summer, UTC+2
});
