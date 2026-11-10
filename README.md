# Flatapp

A shared chore planner for flats. Everyone sees what is due, whose turn it is,
and who has been doing how much.

- **Recurring chores** on any rhythm: every N days, weeks or months.
- **Turns**: everyone rotates, only some people rotate, one fixed person, or
  "whoever gets to it". The turn moves on when a chore is done.
- **To-do view** per person, grouped into overdue, today, next 7 days, later.
- **Pass on** a turn, **undo** a mistake, or log a chore for someone else.
- **Points**: quick chores earn 1 point, medium 2, big 3.
- **Monthly prize**: the flat writes down a reward ("dinner cooked by the
  others"); whoever has the most points at the end of the month wins it. The
  winner is announced in the app and past winners are kept.
- **Reminders**: a push notification in the morning and evening for chores
  that are due or overdue.
- **Live sync**: changes show up on everyone's phone within a second.
- **Works offline**: changes made without a connection are sent later.
- **No accounts**: a flat is shared with an invite link or code.
- **Installable** on iPhone and Android as a PWA.

## How it is built

| Part          | Choice                                                |
| ------------- | ----------------------------------------------------- |
| App           | PWA in plain HTML/CSS/JS, no build step (`web/`)      |
| Data          | Cloud Firestore, read and written directly by the app |
| Hosting       | Firebase Hosting                                      |
| Notifications | Firebase Cloud Messaging (web push)                   |
| Reminder job  | A scheduled GitHub Actions workflow (`reminders/`)    |

Everything fits in Firebase's free Spark plan; no credit card is needed. The
reminder job runs on GitHub Actions because Firebase's own scheduled functions
require the paid plan.

## Set it up

You need a Firebase account and [Node.js](https://nodejs.org).

### 1. Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com), add a
   project. Google Analytics is not needed.
2. **Build → Firestore Database → Create database.** Choose a location near
   you and start in *production mode*.
3. **Project settings → General → Your apps → Web (`</>`).** Register an app
   (no need to tick Hosting) and copy the `firebaseConfig` values into
   [`web/firebase-config.js`](web/firebase-config.js).
4. **Project settings → Cloud Messaging → Web Push certificates → Generate key
   pair.** Copy the key into `vapidKey` in the same file.

These values are not secrets; commit them.

### 2. Deploy

```sh
npm install -g firebase-tools
firebase login
firebase deploy --only hosting,firestore:rules --project YOUR_PROJECT_ID
```

The app is now live at `https://YOUR_PROJECT_ID.web.app`. Run the same deploy
command again after any change to `web/` or `firestore.rules`.

### 3. Turn on reminders

1. **Project settings → Service accounts → Generate new private key.** This
   downloads a JSON file. It *is* a secret: do not commit it.
2. In the GitHub repository: **Settings → Secrets and variables → Actions →
   New repository secret.** Name it `FIREBASE_SERVICE_ACCOUNT` and paste the
   whole content of the JSON file.
3. Test it: **Actions → Chore reminders → Run workflow.**

The workflow in
[`.github/workflows/reminders.yml`](.github/workflows/reminders.yml) runs at
07:00 and 17:00 UTC; change the two `cron` lines to suit your flat. Things to
know:

- GitHub only runs schedules from the repository's default branch, and may
  start them some minutes late.
- GitHub pauses schedules in repositories without activity for 60 days; a
  commit or pressing "Enable workflow" resumes them.
- Each person turns reminders on for their own device in the app (**Flat →
  Reminders**).

## Using it

1. One person opens the site, creates the flat and picks starter chores.
2. They share the invite link from the **Flat** tab.
3. Everyone else opens the link, enters their name, and adds the app to their
   home screen (iPhone: Safari → Share → Add to Home Screen; Android: browser
   menu → Install app).
4. Everyone turns on reminders. On iPhone this only works from the home-screen
   app (iOS 16.4 or later), not from a Safari tab.

Anyone with the invite code can view and edit the flat, so treat it like the
flat's Wi-Fi password.

## How scheduling works

- Completing a chore sets the next due date to *the day it was done* plus the
  interval, so a late chore does not immediately come due again.
- Whoever marks a chore done gets the points, even if it was not their turn.
  The turn then moves to the next person in the rotation.
- Chores set to "everyone takes turns" pick up new flatmates automatically.
  When someone leaves, their turns pass to the next person.
- Reminders go to the person whose turn it is, for chores due today or
  earlier. Chores without turns are announced to everyone.

## Data and access

```
flats/{code}               name, members, chores, prizes, monthly scores
flats/{code}/log/{id}      one entry per finished or passed-on chore
flats/{code}/devices/{id}  push tokens
```

The invite code is the document id. [`firestore.rules`](firestore.rules) lets
anyone who knows a code read and edit that flat, and nobody list flats. Push
tokens can be written by the app but only read by the reminder job.

## Development

```sh
npm test                 # scheduling and reminder rules
npm install -g firebase-tools
npm run dev              # app on http://127.0.0.1:5000 with local emulators
```

For `npm run dev`, temporarily set `projectId: 'demo-flatapp'` in
`web/firebase-config.js`; project ids starting with `demo-` make the app talk
to the local Firestore emulator instead of a real project. The emulator needs
Java.

```
web/app.js          screens and interaction
web/store.js        all Firestore reads and writes
web/schedule.js     due-date and rotation rules
web/push.js         notification permission and token
web/sw.js           offline app shell, shows incoming notifications
web/vendor/         Firebase browser SDK (update: scripts/vendor-firebase.sh)
reminders/          the scheduled reminder job
firestore.rules     who may read and write what
```
