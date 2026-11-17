import test from 'node:test';
import assert from 'node:assert/strict';
import { isDate, nextDue, nextInRotation } from '../web/schedule.js';

test('intervals', () => {
  assert.equal(nextDue('2026-11-10', 3, 'day'), '2026-11-13');
  assert.equal(nextDue('2026-11-10', 2, 'week'), '2026-11-24');
  assert.equal(nextDue('2026-11-10', 1, 'month'), '2026-12-10');
  assert.equal(nextDue('2026-12-20', 1, 'month'), '2027-01-20');
  assert.equal(nextDue('2026-11-30', 3, 'month'), '2027-02-28');
  assert.throws(() => nextDue('2026-11-10', 1, 'year'));
});

test('month end clamps', () => {
  assert.equal(nextDue('2027-01-31', 1, 'month'), '2027-02-28');
  assert.equal(nextDue('2028-01-31', 1, 'month'), '2028-02-29');
  assert.equal(nextDue('2026-10-31', 1, 'month'), '2026-11-30');
});

test('rotation', () => {
  assert.equal(nextInRotation([], 'a'), null);
  assert.equal(nextInRotation(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(nextInRotation(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(nextInRotation(['a', 'b', 'c'], 'x'), 'a');
  assert.equal(nextInRotation(['a', 'b', 'c'], null), 'a');
  assert.equal(nextInRotation(['a'], 'a'), 'a');
});

test('date validation', () => {
  assert.ok(isDate('2026-02-28'));
  assert.ok(!isDate('2026-02-30'));
  assert.ok(!isDate('2026-2-3'));
});

test('points depend on timing', async () => {
  const { pointsFor } = await import('../web/schedule.js');
  assert.equal(pointsFor(2, '2026-11-10', '2026-11-09'), 3); // a day early
  assert.equal(pointsFor(2, '2026-11-10', '2026-11-08'), 3); // two days early
  assert.equal(pointsFor(2, '2026-11-10', '2026-11-07'), 2); // too early for a bonus
  assert.equal(pointsFor(2, '2026-11-10', '2026-11-10'), 2); // on the day
  assert.equal(pointsFor(2, '2026-11-10', '2026-11-12'), 2); // a little late
  assert.equal(pointsFor(2, '2026-11-10', '2026-11-13'), 1); // 3 days late
  assert.equal(pointsFor(1, '2026-11-10', '2026-11-20'), 1); // never below 1
  assert.equal(pointsFor(3, '2026-12-01', '2026-11-29'), 4);
});

test('reminder lead time defaults to 0 and ignores unknown values', async () => {
  const { remindPrefs } = await import('../web/schedule.js');
  assert.equal(remindPrefs({}).ahead, 0);
  assert.equal(remindPrefs({ remind: { ahead: 2 } }).ahead, 2);
  assert.equal(remindPrefs({ remind: { ahead: 9 } }).ahead, 0);
});
