import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigests, localDate } from './digest.mjs';

const chore = (title, assignee_id, next_due) => ({ title, icon: '🧹', assignee_id, next_due });
const flat = {
  members: {
    mia: { name: 'Mia', active: true },
    tom: { name: 'Tom', active: true },
    lea: { name: 'Lea', active: true },
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
};

test('reminds about due and overdue chores only', () => {
  const digests = buildDigests(flat, '2026-11-10');
  const mia = digests.find((d) => d.memberId === 'mia');
  assert.equal(mia.title, '2 chores waiting for you (1 overdue)');
  assert.equal(mia.body, '🧹 Bathroom, 🧹 Kitchen, 🧹 Plants');
});

test('chores without turns go to everyone; nothing due means no reminder', () => {
  const digests = buildDigests(flat, '2026-11-10');
  assert.equal(digests.find((d) => d.memberId === 'tom').title, '1 chore open for anyone');
  assert.equal(digests.find((d) => d.memberId === 'old'), undefined);
  assert.deepEqual(buildDigests(flat, '2026-10-01'), []);
});

test('long lists are shortened', () => {
  const chores = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [i, chore(`C${i}`, 'mia', '2026-11-01')]));
  const [digest] = buildDigests({ members: flat.members, chores }, '2026-11-10');
  assert.ok(digest.body.endsWith('and 2 more'));
});

test('local date follows the flat time zone', () => {
  const now = new Date('2026-11-10T23:30:00Z');
  assert.equal(localDate(now, 'Europe/Berlin'), '2026-11-11');
  assert.equal(localDate(now, 'America/Los_Angeles'), '2026-11-10');
  assert.equal(localDate(now, 'Not/AZone'), '2026-11-10');
});
