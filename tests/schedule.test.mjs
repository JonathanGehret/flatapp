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
