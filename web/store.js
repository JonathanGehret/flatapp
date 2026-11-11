// Data layer. Everything about a flat lives in Firestore:
//
//   flats/{code}               one document: name, members, chores, prizes, monthly scores
//   flats/{code}/log/{id}      one document per finished or passed-on chore
//   flats/{code}/devices/{id}  push tokens (write-only for clients)
//
// The invite code is the document id and works like a password: whoever
// knows it can read and edit the flat (see firestore.rules).
//
// Writes touch only the fields they change (`chores.<id>.next_due`, not the
// whole document), so two flatmates editing at once do not overwrite each
// other, and writes made offline are queued and sent when back online.

import { initializeApp } from './vendor/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator,
  collection, doc, getDocFromServer, setDoc, deleteDoc, onSnapshot, query, orderBy, limit,
  writeBatch, FieldPath, increment, deleteField,
} from './vendor/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { isDate, nextDue, nextInRotation, remindPrefs, REMINDER_HOURS } from './schedule.js';

export const configured = Boolean(firebaseConfig.projectId);

const COLORS = ['#0d9488', '#e11d48', '#7c3aed', '#ea580c', '#2563eb', '#65a30d', '#c026d3', '#ca8a04'];
// No 0/O, 1/I/L: codes get read aloud and typed on phones.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LOG_LIMIT = 60;

export const app = configured ? initializeApp(firebaseConfig) : null;
let db = null;
if (configured) {
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = initializeFirestore(app, {}); // no IndexedDB (private mode): works, without offline data
  }
  // Project ids starting with "demo-" are Firebase's convention for emulator-only projects.
  if (firebaseConfig.projectId.startsWith('demo-')) connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

function random(alphabet, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
const newId = () => `x${random(ID_ALPHABET, 11)}`;
export const normalizeCode = (raw) => String(raw).replace(/[^a-z0-9]/gi, '').toUpperCase();

// ---------- the open flat ----------

let code = null;
let data = null; // raw flat document
let log = []; // newest first
let listener = () => {};
let onWriteError = () => {};
let stop = [];
let waiters = [];

const flatRef = (c = code) => doc(db, 'flats', c);
const logRef = (id) => doc(db, 'flats', code, 'log', id);

/** The shape the UI renders: arrays instead of the maps Firestore stores. */
function toState() {
  const members = Object.entries(data.members ?? {})
    .map(([id, m]) => ({ id, ...m }))
    .sort((a, b) => a.order - b.order);
  const chores = Object.entries(data.chores ?? {})
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => a.next_due.localeCompare(b.next_due) || a.created - b.created);
  const scores = Object.entries(data.scores ?? {}).flatMap(([month, byMember]) => (
    Object.entries(byMember)
      .filter(([, s]) => s.points > 0 || s.count > 0)
      .map(([member_id, s]) => ({ month, member_id, points: s.points ?? 0, count: s.count ?? 0 }))
  ));
  const rewards = Object.entries(data.rewards ?? {})
    .map(([month, text]) => ({ month, text }))
    .sort((a, b) => b.month.localeCompare(a.month));
  // Only the newest entry of a chore can be undone: older ones no longer
  // describe the chore's previous state.
  const activity = log.map((e) => ({ ...e, undoable: data.chores?.[e.chore_id]?.last_log === e.id }));
  return { flat: { name: data.name, code, tz: data.tz }, members, chores, scores, rewards, activity };
}

function emit() {
  if (data) listener({ state: toState() });
}

/**
 * Starts following a flat. `onChange` gets `{ state }` on every change and
 * `{ missing: true }` if the server says the flat does not exist.
 */
export function open(flatCode, onChange, onError) {
  close();
  code = flatCode;
  listener = onChange;
  onWriteError = onError;
  stop = [
    onSnapshot(flatRef(), { includeMetadataChanges: true }, (snap) => {
      if (snap.exists()) {
        data = snap.data();
        emit();
        // Release every write up to the one this snapshot reflects.
        const reached = waiters.findIndex((w) => w.rev === data.rev);
        waiters.splice(0, reached + 1).forEach((w) => w.resolve());
      } else if (!snap.metadata.fromCache) {
        listener({ missing: true });
      }
    }, onError),
    onSnapshot(query(collection(db, 'flats', code, 'log'), orderBy('at', 'desc'), limit(LOG_LIMIT)), (snap) => {
      log = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    }, onError),
  ];
}

export function close() {
  stop.forEach((unsubscribe) => unsubscribe());
  stop = [];
  code = null;
  data = null;
  log = [];
  waiters = [];
}

/**
 * Applies changes to the flat document (and optionally log documents) in one
 * atomic batch. Resolves once the change is visible locally, which also
 * happens offline; the server confirmation is not awaited.
 *
 * Each write stamps the document with a random `rev`, which is how the
 * snapshot listener recognises that this particular write has been applied.
 */
async function write(pairs, extra) {
  const rev = newId();
  const batch = writeBatch(db);
  extra?.(batch);
  batch.update(flatRef(), 'rev', rev, ...pairs.flatMap(([path, value]) => [new FieldPath(...path), value]));
  batch.commit().catch(onWriteError);
  await new Promise((resolve) => {
    waiters.push({ rev, resolve });
    setTimeout(resolve, 3000); // never leave the UI hanging
  });
}

// ---------- helpers on the raw document ----------

const fail = (message) => { throw new Error(message); };
const activeIds = (members = data.members) => Object.entries(members)
  .filter(([, m]) => m.active)
  .sort(([, a], [, b]) => a.order - b.order)
  .map(([id]) => id);
const choreList = () => Object.entries(data.chores ?? {}).sort(([, a], [, b]) => a.created - b.created);

function cleanName(raw, what = 'Name') {
  const name = String(raw ?? '').trim();
  if (!name || name.length > 40) fail(`${what} must be 1 to 40 characters`);
  return name;
}

function newMember(name, members) {
  const taken = Object.values(members).some((m) => m.active && m.name.toLowerCase() === name.toLowerCase());
  if (taken) fail('Someone with that name is already in the flat');
  const count = Object.keys(members).length;
  return { name, color: COLORS[count % COLORS.length], active: true, order: Date.now() };
}

/** The member in `rotation` who currently has the fewest chores waiting. */
function leastLoaded(rotation, extraLoad = {}) {
  let best = null;
  let bestLoad = Infinity;
  for (const id of rotation) {
    const load = (extraLoad[id] ?? 0) + Object.values(data.chores ?? {}).filter((c) => c.assignee_id === id).length;
    if (load < bestLoad) { best = id; bestLoad = load; }
  }
  return best;
}

const scorePairs = (month, memberId, points, count) => [
  [['scores', month, memberId, 'points'], increment(points)],
  [['scores', month, memberId, 'count'], increment(count)],
];

// ---------- flat & members ----------

export async function createFlat(rawName, rawMemberName) {
  const name = cleanName(rawName, 'Flat name');
  const memberId = newId();
  const flatCode = random(CODE_ALPHABET, CODE_LENGTH);
  await setDoc(flatRef(flatCode), {
    name,
    // Reminders are sent according to the flat's local day.
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    created: Date.now(),
    members: { [memberId]: newMember(cleanName(rawMemberName), {}) },
    chores: {},
    rewards: {},
    scores: {},
  });
  return { code: flatCode, memberId };
}

/** Whether a flat with this code exists. Needs a connection. */
export async function flatExists(flatCode) {
  return (await getDocFromServer(flatRef(flatCode))).exists();
}

export const renameFlat = (name) => write([[['name'], cleanName(name, 'Flat name')]]);

export async function addMember(rawName) {
  const memberId = newId();
  const member = newMember(cleanName(rawName), data.members);
  const everyone = [...activeIds(), memberId];
  const pairs = [[['members', memberId], member]];
  // "Everyone takes turns" chores pick up the new person. Chores nobody has
  // done yet are dealt out evenly, so a flat that was just set up does not
  // start with everything on one person.
  choreList().filter(([, c]) => c.assign_mode === 'all').forEach(([id, c], i) => {
    pairs.push([['chores', id, 'rotation'], everyone]);
    if (!c.last_log) pairs.push([['chores', id, 'assignee_id'], everyone[i % everyone.length]]);
  });
  await write(pairs);
  return memberId;
}

export const renameMember = (id, name) => write([[['members', id, 'name'], cleanName(name)]]);

/** Members are deactivated, not deleted, so their history stays readable. */
export async function removeMember(id) {
  if (activeIds().length <= 1) fail('A flat needs at least one person');
  const pairs = [[['members', id, 'active'], false]];
  for (const [choreId, c] of choreList()) {
    if (!c.rotation.includes(id)) continue;
    const rotation = c.rotation.filter((m) => m !== id);
    pairs.push([['chores', choreId, 'rotation'], rotation]);
    if (c.assignee_id === id) {
      // Their turn passes to whoever was next.
      const next = nextInRotation(c.rotation, id);
      pairs.push([['chores', choreId, 'assignee_id'], next === id ? null : next]);
    }
  }
  await write(pairs);
}

/** Saves a member's reminder preferences (hours, overdue_only, open, muted). */
export function setRemindPrefs(memberId, changes) {
  const m = data.members[memberId] ?? fail('Unknown member');
  const next = { ...remindPrefs(m), ...changes };
  next.hours = [...new Set(next.hours)].filter((h) => REMINDER_HOURS.includes(h)).sort((a, b) => a - b);
  // Forget muted chores that no longer exist.
  next.muted = [...new Set(next.muted)].filter((id) => data.chores?.[id]);
  return write([[['members', memberId, 'remind'], next]]);
}

export const setReward = (month, text) => {
  if (!/^\d{4}-\d{2}$/.test(month)) fail('Invalid month');
  const prize = String(text).trim();
  if (prize.length > 120) fail('Keep the prize under 120 characters');
  return write([[['rewards', month], prize]]);
};

// ---------- chores ----------

function choreFields(input) {
  const title = String(input.title ?? '').trim();
  if (!title || title.length > 80) fail('Title must be 1 to 80 characters');
  if (!Number.isInteger(input.interval_n) || input.interval_n < 1 || input.interval_n > 365
    || !['day', 'week', 'month'].includes(input.interval_unit)) fail('Invalid interval');
  if (![1, 2, 3].includes(input.points)) fail('Effort must be 1 to 3');
  if (!isDate(input.next_due)) fail('Invalid due date');
  let rotation;
  if (input.assign_mode === 'all') rotation = activeIds();
  else if (input.assign_mode === 'anyone') rotation = [];
  else if (input.assign_mode === 'custom') {
    rotation = activeIds().filter((id) => (input.rotation ?? []).includes(id));
    if (!rotation.length) fail('Pick at least one person');
  } else fail('Invalid assignment');
  return {
    title,
    icon: String(input.icon ?? '').slice(0, 8),
    interval_n: input.interval_n,
    interval_unit: input.interval_unit,
    points: input.points,
    assign_mode: input.assign_mode,
    rotation,
    next_due: input.next_due,
  };
}

/** Adds one or more chores in a single write. */
export async function addChores(inputs) {
  const load = {};
  const pairs = inputs.map((input, i) => {
    const fields = choreFields(input);
    const assignee = fields.rotation.includes(input.assignee_id) ? input.assignee_id : leastLoaded(fields.rotation, load);
    if (assignee) load[assignee] = (load[assignee] ?? 0) + 1;
    return [['chores', newId()], { ...fields, assignee_id: assignee, last_log: null, created: Date.now() + i }];
  });
  await write(pairs);
}

export async function updateChore(id, input) {
  const existing = data.chores[id] ?? fail('This chore no longer exists');
  const fields = choreFields(input);
  const keep = (m) => (fields.rotation.includes(m) ? m : null);
  const assignee = keep(input.assignee_id) ?? keep(existing.assignee_id) ?? leastLoaded(fields.rotation);
  await write([
    ...Object.entries(fields).map(([key, value]) => [['chores', id, key], value]),
    [['chores', id, 'assignee_id'], assignee],
  ]);
}

/** Past log entries and points are kept; only the chore itself goes away. */
export const deleteChore = (id) => write([[['chores', id], deleteField()]]);

function logEntry(choreId, c, memberId, kind, date) {
  if (!data.members[memberId]?.active) fail('Unknown member');
  if (!isDate(date)) fail('Invalid date');
  return {
    chore_id: choreId,
    title: c.title,
    icon: c.icon,
    member_id: memberId,
    kind,
    date,
    points: kind === 'done' ? c.points : 0,
    // The chore's state before this entry, for undo.
    prev_due: c.next_due,
    prev_assignee: c.assignee_id,
    prev_log: c.last_log ?? null,
    at: Date.now(),
  };
}

/**
 * Whoever marks a chore done gets the points; the turn moves on and the next
 * due date counts from the day it was actually done. Returns the log entry id.
 */
export async function completeChore(id, memberId, date) {
  const c = data.chores[id] ?? fail('This chore no longer exists');
  const entry = logEntry(id, c, memberId, 'done', date);
  const entryId = newId();
  await write([
    [['chores', id, 'next_due'], nextDue(date, c.interval_n, c.interval_unit)],
    [['chores', id, 'assignee_id'], nextInRotation(c.rotation, c.assignee_id)],
    [['chores', id, 'last_log'], entryId],
    ...scorePairs(date.slice(0, 7), memberId, c.points, 1),
  ], (batch) => batch.set(logRef(entryId), entry));
  return entryId;
}

/** Passes the turn to the next person without changing the due date. Returns who is up now. */
export async function skipChore(id, memberId, date) {
  const c = data.chores[id] ?? fail('This chore no longer exists');
  if (c.rotation.length < 2) fail('There is nobody to pass this chore to');
  const entry = logEntry(id, c, memberId, 'skip', date);
  const entryId = newId();
  const next = nextInRotation(c.rotation, c.assignee_id);
  await write([
    [['chores', id, 'assignee_id'], next],
    [['chores', id, 'last_log'], entryId],
  ], (batch) => batch.set(logRef(entryId), entry));
  return next;
}

export async function undo(entryId) {
  const entry = log.find((e) => e.id === entryId) ?? fail('This entry is gone');
  const c = data.chores[entry.chore_id];
  if (!c || c.last_log !== entryId) fail('Only the latest entry of a chore can be undone');
  // The previous assignee may have left the flat or the rotation since.
  const valid = entry.prev_assignee == null ? !c.rotation.length : c.rotation.includes(entry.prev_assignee);
  await write([
    [['chores', entry.chore_id, 'next_due'], entry.prev_due],
    [['chores', entry.chore_id, 'assignee_id'], valid ? entry.prev_assignee : c.assignee_id],
    [['chores', entry.chore_id, 'last_log'], entry.prev_log ?? null],
    ...(entry.kind === 'done' ? scorePairs(entry.date.slice(0, 7), entry.member_id, -entry.points, -1) : []),
  ], (batch) => batch.delete(logRef(entryId)));
}

// ---------- push devices ----------

/** Registers this device's push token for a member. Clients can write tokens but never read them. */
export const saveDevice = (flatCode, deviceId, memberId, token) => (
  setDoc(doc(db, 'flats', flatCode, 'devices', deviceId), { token, member_id: memberId, at: Date.now() })
);
export const removeDevice = (flatCode, deviceId) => deleteDoc(doc(db, 'flats', flatCode, 'devices', deviceId));
