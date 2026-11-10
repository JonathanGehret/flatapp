// Flatapp client. `store.js` keeps `state` in sync with Firestore; the UI is
// a pure render of it.

import * as store from './store.js';
import { fmt, toDate } from './schedule.js';

const LS_SESSION = 'flatapp.session';
const LS_STATE = 'flatapp.state';
const LS_DEVICE = 'flatapp.device';

const ICONS = ['🧹', '🧽', '🍽️', '🚿', '🚽', '🗑️', '♻️', '🧺', '🪟', '🛒', '🌱', '🧊', '🛏️', '🧴', '📦', '🐈', '🔧', '✨'];
const EFFORT = ['', 'Quick', 'Medium', 'Big'];
const TEMPLATES = [
  { title: 'Take out the trash', icon: '🗑️', interval_n: 3, interval_unit: 'day', points: 1, on: true },
  { title: 'Clean the kitchen', icon: '🍽️', interval_n: 1, interval_unit: 'week', points: 2, on: true },
  { title: 'Clean the bathroom', icon: '🚿', interval_n: 1, interval_unit: 'week', points: 3, on: true },
  { title: 'Vacuum shared rooms', icon: '🧹', interval_n: 1, interval_unit: 'week', points: 2, on: true },
  { title: 'Take out recycling', icon: '♻️', interval_n: 1, interval_unit: 'week', points: 1, on: true },
  { title: 'Mop the floors', icon: '🧽', interval_n: 2, interval_unit: 'week', points: 2, on: true },
  { title: 'Buy shared supplies', icon: '🛒', interval_n: 2, interval_unit: 'week', points: 1 },
  { title: 'Water the plants', icon: '🌱', interval_n: 1, interval_unit: 'week', points: 1 },
  { title: 'Clean the fridge', icon: '🧊', interval_n: 1, interval_unit: 'month', points: 2 },
  { title: 'Clean the windows', icon: '🪟', interval_n: 3, interval_unit: 'month', points: 3 },
];

const read = (key) => {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};
const write = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode: the app still works, it just forgets on reload */ }
};

let session = read(LS_SESSION); // { code, memberId }
let state = session ? read(LS_STATE) : null; // last known state, for an instant first paint
let device = read(LS_DEVICE); // { id, on, nudged }: this device's reminder setting
// `joining` holds a flat we can see but have not picked a person in yet.
const ui = { tab: 'tasks', filter: 'mine', offline: !navigator.onLine, joining: null, setup: false };

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => fmt(new Date());
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return fmt(d); };
const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / 864e5);
const shortDate = (s) => toDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

const member = (id) => state.members.find((m) => m.id === id);
const activeMembers = () => state.members.filter((m) => m.active);
const me = () => state?.members.find((m) => m.id === session?.memberId && m.active);
const chore = (id) => state.chores.find((c) => c.id === id);

function avatar(m, cls = '') {
  if (!m) return `<span class="avatar anyone ${cls}" title="Anyone">★</span>`;
  return `<span class="avatar ${cls}" style="background:${esc(m.color)}" title="${esc(m.name)}">${esc([...m.name][0].toUpperCase())}</span>`;
}

function intervalLabel(c) {
  return c.interval_n === 1 ? `Every ${c.interval_unit}` : `Every ${c.interval_n} ${c.interval_unit}s`;
}

function dueLabel(c) {
  const d = diffDays(c.next_due, todayStr());
  if (d < 0) return { text: `${plural(-d, 'day')} overdue`, cls: 'late' };
  if (d === 0) return { text: 'Today', cls: 'now' };
  if (d === 1) return { text: 'Tomorrow', cls: '' };
  if (d < 7) return { text: toDate(c.next_due).toLocaleDateString(undefined, { weekday: 'long' }), cls: '' };
  return { text: shortDate(c.next_due), cls: '' };
}

let toastTimer;
function toast(text, action) {
  toastEl.innerHTML = esc(text) + (action ? `<button type="button">${esc(action.label)}</button>` : '');
  if (action) toastEl.querySelector('button').onclick = () => { toastEl.classList.remove('show'); action.run(); };
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), action ? 6000 : 3200);
}

// ---------- data ----------

function friendly(err) {
  if (err?.code === 'unavailable') return "You're offline. Try again once you're connected.";
  if (err?.code === 'permission-denied') return 'That change was not allowed.';
  return err?.message || 'Something went wrong';
}

let lastRendered = '';
function setState(next) {
  const json = JSON.stringify(next);
  if (json === lastRendered) return; // Firestore also reports metadata-only changes
  lastRendered = json;
  state = next;
  write(LS_STATE, state);
  // Removed from the flat on another device: ask who is using this phone.
  if (session && !me()) {
    ui.joining = { code: session.code };
    setSession(null, true);
  }
  render();
}

/** `keepFlat` stays connected to the flat, e.g. to pick a different person. */
function setSession(next, keepFlat = false) {
  session = next;
  write(LS_SESSION, session);
  if (!next && !keepFlat) {
    state = null;
    lastRendered = '';
    write(LS_STATE, null);
    store.close();
  }
}

function follow(code) {
  store.open(code, ({ state: next, missing }) => {
    if (missing) {
      ui.joining = null;
      setSession(null);
      render();
      toast('This flat no longer exists.');
    } else {
      setState(next);
    }
  }, (err) => toast(friendly(err)));
}

/** Runs a change. Resolves to its result, or false (after a toast) on failure. */
async function run(change) {
  try {
    return (await change()) ?? true;
  } catch (err) {
    toast(friendly(err));
    return false;
  }
}

async function lookUpFlat(rawCode) {
  const code = store.normalizeCode(rawCode);
  if (!code) return;
  try {
    if (!(await store.flatExists(code))) return toast("That code doesn't match any flat.");
  } catch (err) {
    return toast(friendly(err));
  }
  dropDevice();
  setSession(null); // switching flats: the old identity does not apply
  ui.joining = { code };
  follow(code);
  render();
}

// ---------- reminders ----------

const pushAvailable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushOn = () => Boolean(device?.on) && pushAvailable() && Notification.permission === 'granted';
const setDevice = (next) => { device = next; write(LS_DEVICE, device); };

/** Registers this device's push token for the current person. */
async function registerDevice() {
  const { enable } = await import('./push.js');
  const token = await enable();
  const id = device?.id ?? crypto.randomUUID();
  await store.saveDevice(session.code, id, session.memberId, token);
  setDevice({ ...device, id, on: true });
}

/** Keeps the token fresh and attached to whoever uses this device now. */
function syncDevice() {
  if (session && pushOn()) registerDevice().catch(() => {});
}

/** Stops reminders for the person who was using this device. */
function dropDevice() {
  if (session && device?.on) store.removeDevice(session.code, device.id).catch(() => {});
}

function setupNotice() {
  return `<div class="shell"><div class="welcome">
    <img class="logo" src="icon.svg" alt="">
    <h1>Almost there.</h1>
    <p>This copy of Flatapp is not connected to a Firebase project yet. Add your project's settings to <code>web/firebase-config.js</code> and deploy again. The README has the steps.</p>
  </div></div>`;
}

// ---------- screens: getting in ----------

function welcomeScreen() {
  return `<div class="shell"><div class="welcome">
    <img class="logo" src="icon.svg" alt="">
    <h1>Chores, shared fairly.</h1>
    <p>One list for the whole flat. Everyone sees whose turn it is and what's due.</p>
    <form class="panel" data-form="create">
      <h2>Start a new flat</h2>
      <label for="flat-name">Flat name</label>
      <input id="flat-name" name="name" type="text" maxlength="40" placeholder="e.g. Elm Street 12" required>
      <label for="member-name">Your name</label>
      <input id="member-name" name="member_name" type="text" maxlength="40" autocomplete="given-name" required>
      <div class="btns"><button class="btn">Create flat</button></div>
    </form>
    <form class="panel" data-form="join">
      <h2>Join your flatmates</h2>
      <label for="join-code">Invite code</label>
      <input id="join-code" name="code" type="text" autocapitalize="characters" autocomplete="off" placeholder="XXXXX-XXXXX" required>
      <div class="btns"><button class="btn ghost">Join flat</button></div>
    </form>
  </div></div>`;
}

function pickerScreen() {
  return `<div class="shell"><div class="welcome">
    <h1>${esc(state.flat.name)}</h1>
    <p>Who's using this device?</p>
    <div class="people">
      ${activeMembers().map((m) => `<button class="person" data-action="pick" data-id="${m.id}">${avatar(m)}${esc(m.name)}</button>`).join('')}
    </div>
    <form class="panel" data-form="new-member">
      <h2>I'm new here</h2>
      <label for="new-name">Your name</label>
      <input id="new-name" name="name" type="text" maxlength="40" autocomplete="given-name" required>
      <div class="btns"><button class="btn">Join ${esc(state.flat.name)}</button></div>
    </form>
    <div class="btns"><button class="link" data-action="leave-now">Use a different flat</button></div>
  </div></div>`;
}

function setupScreen() {
  return `<div class="shell"><form class="welcome" data-form="setup">
    <h1>What needs doing?</h1>
    <p>Pick some chores to start with. You can change everything later, and flatmates who join are added to the rotation automatically.</p>
    ${TEMPLATES.map((t, i) => `<label class="choice">
      <input type="checkbox" name="t" value="${i}" ${t.on ? 'checked' : ''}>
      <span>${t.icon} ${esc(t.title)}<small>${intervalLabel(t)}</small></span>
    </label>`).join('')}
    <div class="btns">
      <button class="btn">Add these chores</button>
      <button class="link" type="button" data-action="skip-setup">Start with an empty list</button>
    </div>
  </form></div>`;
}

// ---------- screens: main ----------

function choreCard(c) {
  const due = dueLabel(c);
  const who = member(c.assignee_id);
  const mine = c.assignee_id === session.memberId;
  return `<div class="card ${mine ? 'mine' : ''}">
    <button class="open" data-action="open" data-id="${c.id}">
      <span class="icon">${esc(c.icon)}</span>
      <span class="body">
        <span class="title">${esc(c.title)}</span>
        <span class="meta"><span class="${due.cls}">${esc(due.text)}</span>·${avatar(who, 'sm')}<span>${who ? (mine ? 'You' : esc(who.name)) : 'Anyone'}</span>·<span class="gain">+${c.points}</span></span>
      </span>
    </button>
    <button class="check" data-action="done" data-id="${c.id}" aria-label="Mark ${esc(c.title)} done">✓</button>
  </div>`;
}

function tasksView() {
  const filter = `<div class="seg">
    <button data-action="filter" data-filter="mine" aria-pressed="${ui.filter === 'mine'}">My turn</button>
    <button data-action="filter" data-filter="all" aria-pressed="${ui.filter === 'all'}">Everyone</button>
  </div>`;
  if (!state.chores.length) {
    return `<div class="empty"><div class="big">🧹</div><b>No chores yet</b>Add the first one with the button below.</div>`;
  }
  const today = todayStr();
  const list = state.chores.filter((c) => ui.filter === 'all' || c.assignee_id === session.memberId || c.assignee_id == null);
  const groups = [
    ['Overdue', 'overdue', (d) => d < 0],
    ['Today', '', (d) => d === 0],
    ['Next 7 days', '', (d) => d > 0 && d <= 7],
    ['Later', '', (d) => d > 7],
  ];
  const html = groups.map(([name, cls, test]) => {
    const items = list.filter((c) => test(diffDays(c.next_due, today)));
    if (!items.length) return '';
    return `<div class="section ${cls}"><h2>${name}</h2><small>${items.length}</small></div>${items.map(choreCard).join('')}`;
  }).join('');
  const nudge = pushAvailable() && !device?.on && !device?.nudged ? `<div class="nudge">
      <span class="icon">🔔</span>
      <div class="grow"><b>Get reminded</b><div class="sub">A notification when your chores are due.</div></div>
      <button class="link" data-action="push-on">Turn on</button>
      <button class="close" data-action="push-later" aria-label="Not now">✕</button>
    </div>` : '';
  return filter + nudge + (html || `<div class="empty"><div class="big">🎉</div><b>Nothing on your plate</b>None of the chores are yours right now.</div>`);
}

function choresView() {
  if (!state.chores.length) {
    return `<div class="empty"><div class="big">📋</div><b>No chores yet</b>Add everything that needs doing regularly.</div>`;
  }
  const sorted = [...state.chores].sort((a, b) => a.title.localeCompare(b.title));
  return `<div class="section"><h2>All chores</h2><small>${sorted.length}</small></div>` + sorted.map((c) => `
    <button class="card" data-action="open" data-id="${c.id}">
      <span class="icon">${esc(c.icon)}</span>
      <span class="body">
        <span class="title">${esc(c.title)}</span>
        <span class="meta">${intervalLabel(c)} · ${EFFORT[c.points]}</span>
      </span>
      ${c.rotation.length ? c.rotation.map((id) => avatar(member(id), 'sm')).join('') : avatar(null, 'sm')}
    </button>`).join('');
}

// ---------- monthly race ----------

const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${pad(mo - 1)}`; };
function monthName(m) {
  const [y, mo] = m.split('-').map(Number);
  const sameYear = y === new Date().getFullYear();
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
}
/** A month plays for its own prize, or else the most recent one set before it. */
const rewardFor = (month) => state.rewards.find((r) => r.month <= month)?.text ?? '';
const boardFor = (month) => state.scores.filter((s) => s.month === month);
function winnersOf(month) {
  const board = boardFor(month);
  const top = Math.max(0, ...board.map((s) => s.points));
  return top ? { points: top, members: board.filter((s) => s.points === top).map((s) => member(s.member_id)).filter(Boolean) } : null;
}
const names = (members) => members.map((m) => esc(m.name)).join(' & ');

function scoresView() {
  const today = todayStr();
  const month = today.slice(0, 7);
  const last = prevMonth(month);
  const board = boardFor(month);
  // Everyone in the flat, plus anyone who scored this month before leaving.
  const rows = state.members.filter((m) => m.active || board.some((s) => s.member_id === m.id)).map((m) => {
    const s = board.find((x) => x.member_id === m.id);
    return { m, points: s?.points ?? 0, count: s?.count ?? 0 };
  }).sort((a, b) => b.points - a.points);
  const max = Math.max(1, ...rows.map((r) => r.points));
  const leading = rows[0]?.points ?? 0;
  const [y, mo] = month.split('-').map(Number);
  const daysLeft = new Date(y, mo, 0).getDate() - toDate(today).getDate();
  const prize = rewardFor(month);
  const lastWin = winnersOf(last);
  const lastPrize = rewardFor(last);
  const earlier = [...new Set(state.scores.map((s) => s.month))].filter((m) => m < last);
  const when = (date) => {
    const d = diffDays(today, date);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : shortDate(date);
  };

  return `${lastWin ? `<div class="winner">
      <div class="big">🏆</div>
      <div><b>${names(lastWin.members)} won ${monthName(last)}</b>
      <div>${lastWin.points} points${lastPrize ? ` · Prize: ${esc(lastPrize)}` : ''}</div></div>
    </div>` : ''}
  <div class="section"><h2>${monthName(month)}</h2><small>${daysLeft ? `${plural(daysLeft, 'day')} left` : 'last day'}</small></div>
  <div class="panel">
    <div class="row">
      <span class="icon">🎁</span>
      <div class="grow"><div class="sub">Prize for the most points</div><div>${prize ? esc(prize) : 'No prize set yet'}</div></div>
      <button class="link" data-action="set-reward">${prize ? 'Change' : 'Set a prize'}</button>
    </div>
    ${rows.map((r) => `<div class="row">
      ${avatar(r.m)}
      <div class="grow">
        <div>${esc(r.m.name)}${r.points && r.points === leading ? ' 👑' : ''}</div>
        <div class="bar"><i style="width:${(r.points / max) * 100}%;background:${esc(r.m.color)}"></i></div>
      </div>
      <div style="text-align:right"><div class="pts">${r.points}</div><div class="sub">${plural(r.count, 'chore')}</div></div>
    </div>`).join('')}</div>
  <p class="hint" style="margin-top:8px">Quick chores earn 1 point, medium 2, big 3. Whoever has the most at the end of the month wins the prize.</p>
  <div class="section"><h2>Activity</h2></div>
  ${state.activity.length ? `<div class="panel">${state.activity.map((a) => `<div class="row">
      <span class="icon">${esc(a.icon)}</span>
      <div class="grow">
        <div><b>${esc(member(a.member_id)?.name ?? 'Someone')}</b> ${a.kind === 'done' ? 'did' : 'passed on'} ${esc(a.title)}</div>
        <div class="sub">${when(a.date)}${a.kind === 'done' ? ` · +${a.points}` : ''}</div>
      </div>
      ${a.undoable ? `<button class="link" data-action="undo" data-id="${a.id}">Undo</button>` : ''}
    </div>`).join('')}</div>` : `<p class="hint">Finished chores show up here.</p>`}
  ${earlier.length ? `<div class="section"><h2>Past winners</h2></div>
  <div class="panel">${earlier.map((m) => {
    const w = winnersOf(m);
    const p = rewardFor(m);
    return w ? `<div class="row">
      ${avatar(w.members[0])}
      <div class="grow"><div><b>${names(w.members)}</b> · ${monthName(m)}</div>
      <div class="sub">${w.points} points${p ? ` · ${esc(p)}` : ''}</div></div>
    </div>` : '';
  }).join('')}</div>` : ''}`;
}

function flatView() {
  return `<div class="section"><h2>Invite flatmates</h2></div>
  <div class="panel" style="padding-bottom:14px">
    <div class="code">${formatCode(state.flat.code)}</div>
    <p class="hint" style="text-align:center">Anyone with this code can see and edit the flat.</p>
    <div class="btns two">
      <button class="btn" data-action="share">Share link</button>
      <button class="btn ghost" data-action="copy">Copy code</button>
    </div>
  </div>
  ${`<div class="section"><h2>Reminders</h2></div>
  <div class="panel">${pushAvailable() ? `<div class="row">
      <span class="icon">🔔</span>
      <div class="grow">Notify this device when my chores are due<div class="sub">${pushOn() ? 'On' : 'Off'}</div></div>
      <button class="link" data-action="${pushOn() ? 'push-off' : 'push-on'}">${pushOn() ? 'Turn off' : 'Turn on'}</button>
    </div>` : `<div class="row"><div class="grow sub">Notifications are not available here. On iPhone, first add the app to your home screen (Safari → Share → Add to Home Screen), then open it from there.</div></div>`}
  </div>`}
  <div class="section"><h2>People</h2></div>
  <div class="panel">
    ${activeMembers().map((m) => `<div class="row">
      ${avatar(m)}
      <div class="grow">${esc(m.name)}${m.id === session.memberId ? ' <span class="sub">(you)</span>' : ''}</div>
      <button class="link" data-action="rename-member" data-id="${m.id}">Rename</button>
      ${m.id !== session.memberId ? `<button class="link danger" data-action="remove-member" data-id="${m.id}">Remove</button>` : ''}
    </div>`).join('')}
    <div class="row"><button class="link" data-action="add-member">+ Add someone without a phone</button></div>
  </div>
  <div class="section"><h2>This flat</h2></div>
  <div class="panel">
    <div class="row"><div class="grow">${esc(state.flat.name)}</div><button class="link" data-action="rename-flat">Rename</button></div>
    <div class="row"><div class="grow">Using this device as someone else?</div><button class="link" data-action="switch">Switch</button></div>
    <div class="row"><div class="grow">Sign out on this device</div><button class="link danger" data-action="leave">Leave</button></div>
  </div>
  <p class="hint" style="margin-top:16px">Install as an app: on iPhone, open in Safari and choose Share → Add to Home Screen. On Android, open the browser menu and choose Install app.</p>`;
}

function mainScreen() {
  const tabs = [['tasks', '✅', 'To do'], ['chores', '📋', 'Chores'], ['scores', '🏆', 'Scores'], ['flat', '🏠', 'Flat']];
  const views = { tasks: tasksView, chores: choresView, scores: scoresView, flat: flatView };
  return `<div class="shell">
    <header class="top">
      <h1>${esc(state.flat.name)}</h1>
      ${ui.offline ? '<span class="offline">Offline</span>' : ''}
      ${avatar(me())}
    </header>
    <main>${views[ui.tab]()}</main>
    ${ui.tab === 'tasks' || ui.tab === 'chores' ? '<button class="fab" data-action="new">+ Add chore</button>' : ''}
    <nav class="tabs"><div class="tabs-inner">
      ${tabs.map(([id, icon, label]) => `<button class="tab" data-action="tab" data-tab="${id}" ${ui.tab === id ? 'aria-current="page"' : ''}><span>${icon}</span>${label}</button>`).join('')}
    </div></nav>
  </div>`;
}

function render() {
  if (session && state && me()) app.innerHTML = ui.setup ? setupScreen() : mainScreen();
  else if (ui.joining && state) app.innerHTML = pickerScreen();
  else app.innerHTML = welcomeScreen();
}

// ---------- sheets ----------

function openSheet(html) {
  sheet.innerHTML = `<div class="sheet">${html}</div>`;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}

function detailSheet(id) {
  const c = chore(id);
  if (!c) return;
  const due = dueLabel(c);
  const people = activeMembers();
  openSheet(`
    <div class="sheet-head"><span class="icon">${esc(c.icon)}</span><h2>${esc(c.title)}</h2><button class="close" data-action="close" aria-label="Close">✕</button></div>
    <dl class="facts">
      <div><dt>Due</dt><dd class="meta" style="margin:0;font-size:15px"><span class="${due.cls}">${esc(due.text)}</span> (${shortDate(c.next_due)})</dd></div>
      <div><dt>Repeats</dt><dd style="margin:0">${intervalLabel(c)} · ${EFFORT[c.points]} (${plural(c.points, 'point')})</dd></div>
      <div><dt>Turns</dt><dd style="margin:0;display:flex;gap:6px;flex-wrap:wrap">${c.rotation.length
        ? c.rotation.map((mid) => `<span class="chip ${mid === c.assignee_id ? 'turn' : ''}">${avatar(member(mid), 'sm')}${esc(member(mid)?.name)}</span>`).join('')
        : 'Whoever gets to it'}</dd></div>
    </dl>
    <form data-form="complete" data-id="${c.id}">
      <label for="done-by">Done by</label>
      <select id="done-by" name="member_id">${people.map((m) => `<option value="${m.id}" ${m.id === session.memberId ? 'selected' : ''}>${esc(m.name)}${m.id === session.memberId ? ' (you)' : ''}</option>`).join('')}</select>
      <div class="btns"><button class="btn">Mark as done</button></div>
    </form>
    <div class="btns">
      ${c.rotation.length > 1 ? `<button class="btn ghost" data-action="skip" data-id="${c.id}">Pass to the next person</button>` : ''}
      <div class="btns two" style="margin:0">
        <button class="btn ghost" data-action="edit" data-id="${c.id}">Edit</button>
        <button class="btn danger" data-action="delete" data-id="${c.id}">Delete</button>
      </div>
    </div>`);
}

function formSheet(id) {
  const c = id ? chore(id) : null;
  const v = c ?? { title: '', icon: ICONS[0], interval_n: 1, interval_unit: 'week', points: 2, assign_mode: 'all', rotation: [], assignee_id: null, next_due: todayStr() };
  const icons = ICONS.includes(v.icon) ? ICONS : [v.icon, ...ICONS];
  const people = activeMembers();
  const mode = (value, title, sub) => `<label class="choice"><input type="radio" name="assign_mode" value="${value}" ${v.assign_mode === value ? 'checked' : ''}><span>${title}<small>${sub}</small></span></label>`;
  openSheet(`
    <div class="sheet-head"><h2>${c ? 'Edit chore' : 'New chore'}</h2><button class="close" data-action="close" aria-label="Close">✕</button></div>
    <form data-form="chore" data-id="${c?.id ?? ''}">
      <label for="c-title">What needs doing?</label>
      <input id="c-title" name="title" type="text" maxlength="80" value="${esc(v.title)}" placeholder="e.g. Clean the bathroom" required>

      <span class="label">Icon</span>
      <input type="hidden" name="icon" value="${esc(v.icon)}">
      <div class="picker" data-picker="icon">${icons.map((i) => `<button type="button" data-action="pick-value" data-value="${esc(i)}" aria-pressed="${i === v.icon}">${esc(i)}</button>`).join('')}</div>

      <label for="c-n">Repeat every</label>
      <div class="inline">
        <input id="c-n" name="interval_n" type="number" inputmode="numeric" min="1" max="365" value="${v.interval_n}" required>
        <select name="interval_unit" aria-label="Unit">${['day', 'week', 'month'].map((u) => `<option value="${u}" ${u === v.interval_unit ? 'selected' : ''}>${u}(s)</option>`).join('')}</select>
      </div>

      <label for="c-due">Next due</label>
      <input id="c-due" name="next_due" type="date" value="${v.next_due}" required>

      <span class="label">Effort</span>
      <input type="hidden" name="points" value="${v.points}">
      <div class="seg" data-picker="points">${[1, 2, 3].map((p) => `<button type="button" data-action="pick-value" data-value="${p}" aria-pressed="${p === v.points}">${EFFORT[p]}</button>`).join('')}</div>

      <span class="label">Who does it?</span>
      ${mode('all', 'Everyone takes turns', 'New flatmates join the rotation automatically')}
      ${mode('custom', 'Only some people', 'One person, or a rotation you choose')}
      <div class="indent" id="custom-people" ${v.assign_mode === 'custom' ? '' : 'hidden'}>
        ${people.map((m) => `<label class="choice"><input type="checkbox" name="rotation" value="${m.id}" ${v.rotation.includes(m.id) && v.assign_mode === 'custom' ? 'checked' : ''}>${avatar(m, 'sm')}<span>${esc(m.name)}</span></label>`).join('')}
      </div>
      ${mode('anyone', 'Whoever gets to it', 'No turns, shows up for everybody')}

      <div id="turn-field" ${v.assign_mode === 'anyone' ? 'hidden' : ''}>
        <label for="c-turn">Whose turn is it?</label>
        <select id="c-turn" name="assignee_id">
          ${c ? '' : '<option value="">Whoever has the least to do</option>'}
          ${people.map((m) => `<option value="${m.id}" ${m.id === v.assignee_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
        </select>
      </div>

      <div class="btns"><button class="btn">${c ? 'Save changes' : 'Add chore'}</button></div>
    </form>`);
}

// ---------- actions ----------

async function complete(id, memberId = session.memberId) {
  const c = chore(id);
  if (!c) return;
  const entryId = await run(() => store.completeChore(c.id, memberId, todayStr()));
  if (entryId) toast(`Done: ${c.title} · +${c.points}`, { label: 'Undo', run: () => run(() => store.undo(entryId)) });
}

const actions = {
  tab: (el) => { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  filter: (el) => { ui.filter = el.dataset.filter; render(); },
  open: (el) => detailSheet(el.dataset.id),
  new: () => formSheet(null),
  edit: (el) => formSheet(el.dataset.id),
  close: () => sheet.close(),
  done: (el) => complete(el.dataset.id),
  undo: (el) => run(() => store.undo(el.dataset.id)),

  async skip(el) {
    const next = await run(() => store.skipChore(el.dataset.id, session.memberId, todayStr()));
    if (next) {
      sheet.close();
      toast(`Now it's ${member(next)?.name ?? 'someone else'}'s turn`);
    }
  },
  async delete(el) {
    const c = chore(el.dataset.id);
    if (!c || !confirm(`Delete "${c.title}"? Points already earned are kept.`)) return;
    if (await run(() => store.deleteChore(c.id))) sheet.close();
  },
  'pick-value'(el) {
    const picker = el.closest('[data-picker]');
    picker.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === el));
    picker.closest('form').elements[picker.dataset.picker].value = el.dataset.value;
  },

  pick(el) {
    setSession({ code: ui.joining.code, memberId: el.dataset.id });
    ui.joining = null;
    render();
    syncDevice();
  },
  'leave-now'() { ui.joining = null; setSession(null); render(); },
  'skip-setup'() { ui.setup = false; render(); },

  async share() {
    const url = `${location.origin}/#join=${state.flat.code}`;
    const text = `Join "${state.flat.name}" on Flatapp`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Flatapp', text, url }); } catch { /* cancelled */ }
    } else {
      await copy(url, 'Invite link copied');
    }
  },
  copy: () => copy(formatCode(state.flat.code), 'Code copied'),

  async 'add-member'() {
    const name = prompt('Name of the new flatmate');
    if (!name?.trim()) return;
    await run(() => store.addMember(name));
  },
  'rename-member'(el) {
    const m = member(el.dataset.id);
    const name = prompt('New name', m.name);
    if (name?.trim() && name.trim() !== m.name) run(() => store.renameMember(m.id, name));
  },
  'remove-member'(el) {
    const m = member(el.dataset.id);
    if (confirm(`Remove ${m.name} from the flat? Their turns pass to the others.`)) run(() => store.removeMember(m.id));
  },
  'set-reward'() {
    const month = todayStr().slice(0, 7);
    const current = rewardFor(month);
    const text = prompt(`What does the winner of ${monthName(month)} get?\n(e.g. "Picks the next movie night" or "Dinner cooked by the others")`, current);
    if (text != null && text.trim() !== current) run(() => store.setReward(month, text));
  },
  'rename-flat'() {
    const name = prompt('Flat name', state.flat.name);
    if (name?.trim() && name.trim() !== state.flat.name) run(() => store.renameFlat(name));
  },
  switch() { dropDevice(); ui.joining = { code: session.code }; setSession(null, true); render(); },

  async 'push-on'(el) {
    el.disabled = true;
    try {
      await registerDevice();
      toast('Reminders are on for this device');
    } catch (err) {
      toast(friendly(err));
    }
    render();
  },
  async 'push-off'() {
    dropDevice();
    setDevice({ ...device, on: false });
    render();
    const { disable } = await import('./push.js');
    disable().catch(() => {});
  },
  'push-later'() { setDevice({ ...device, nudged: true }); render(); },
  leave() {
    if (!confirm('Sign out of this flat on this device? You can rejoin with the invite code.')) return;
    dropDevice();
    setSession(null);
    render();
  },
};

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    prompt('Copy this:', text);
  }
}

const forms = {
  async create(data) {
    const { code, memberId } = await store.createFlat(data.get('name'), data.get('member_name'));
    setSession({ code, memberId });
    ui.setup = true;
    follow(code);
  },
  join: (data) => lookUpFlat(data.get('code')),
  async 'new-member'(data) {
    const memberId = await store.addMember(data.get('name'));
    setSession({ code: ui.joining.code, memberId }, true);
    ui.joining = null;
    render();
  },
  async setup(data) {
    const today = todayStr();
    // Spread first due dates over the coming days so not everything lands at once.
    await store.addChores(data.getAll('t').map((t, i) => {
      const { on, ...fields } = TEMPLATES[t];
      return { ...fields, assign_mode: 'all', next_due: addDays(today, i % 7) };
    }));
    ui.setup = false;
    render();
  },
  async complete(data, form) {
    sheet.close();
    await complete(form.dataset.id, data.get('member_id'));
  },
  async chore(data, form) {
    const body = {
      title: data.get('title'),
      icon: data.get('icon'),
      interval_n: Number(data.get('interval_n')),
      interval_unit: data.get('interval_unit'),
      points: Number(data.get('points')),
      assign_mode: data.get('assign_mode'),
      rotation: data.getAll('rotation'),
      assignee_id: data.get('assignee_id') || null,
      next_due: data.get('next_due'),
    };
    const id = form.dataset.id;
    await (id ? store.updateChore(id, body) : store.addChores([body]));
    sheet.close();
  },
};

document.addEventListener('click', (e) => {
  if (e.target === sheet) return sheet.close(); // tap on the backdrop
  const el = e.target.closest('[data-action]');
  if (el) actions[el.dataset.action]?.(el);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const button = form.querySelector('button:not([type="button"])');
  if (button) button.disabled = true;
  try {
    await forms[form.dataset.form](new FormData(form), form);
  } catch (err) {
    toast(friendly(err));
  } finally {
    if (button) button.disabled = false;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.name !== 'assign_mode') return;
  sheet.querySelector('#custom-people').hidden = e.target.value !== 'custom';
  sheet.querySelector('#turn-field').hidden = e.target.value === 'anyone';
});

// ---------- start ----------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

if (!store.configured) {
  app.innerHTML = setupNotice();
} else {
  render();
  // Invite links look like https://host/#join=CODE.
  const readInvite = () => {
    const invite = new URLSearchParams(location.hash.slice(1)).get('join');
    if (!invite) return;
    history.replaceState(null, '', location.pathname);
    if (store.normalizeCode(invite) !== session?.code) lookUpFlat(invite);
  };
  if (session) {
    follow(session.code);
    syncDevice();
  }
  readInvite();
  window.addEventListener('hashchange', readInvite);

  const connection = () => { ui.offline = !navigator.onLine; render(); };
  window.addEventListener('online', connection);
  window.addEventListener('offline', connection);
  // Due labels depend on today's date: refresh when the app comes back to the front.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheet.open) render(); });
}
