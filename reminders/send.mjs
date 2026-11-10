// Sends each flatmate a push notification about chores that are due.
// Run on a schedule by .github/workflows/reminders.yml.
//
//   FIREBASE_SERVICE_ACCOUNT  service account key (JSON) of the Firebase project
//   DRY_RUN=1                 print what would be sent instead of sending
//
// With FIRESTORE_EMULATOR_HOST set it talks to the local emulator instead.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { buildDigests, localDate } from './digest.mjs';

const dryRun = process.env.DRY_RUN === '1';
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (emulator) {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-flatapp' });
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
} else {
  console.error('FIREBASE_SERVICE_ACCOUNT is not set. Add it as a repository secret (see README).');
  process.exit(1);
}

const db = getFirestore();
// Tokens that will never work again; anything else may be a temporary failure.
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const now = new Date();
let sent = 0;
let failed = 0;
let removed = 0;

const flats = await db.collection('flats').get();
for (const flatDoc of flats.docs) {
  const flat = flatDoc.data();
  const digests = buildDigests(flat, localDate(now, flat.tz));
  if (!digests.length) continue;

  const devices = (await flatDoc.ref.collection('devices').get()).docs;
  for (const digest of digests) {
    const targets = devices.filter((d) => d.data().member_id === digest.memberId);
    if (!targets.length) continue;
    if (dryRun) {
      console.log(`[dry run] ${targets.length} device(s): ${digest.title}`);
      sent += targets.length;
      continue;
    }
    const result = await getMessaging().sendEachForMulticast({
      tokens: targets.map((d) => d.data().token),
      data: { title: digest.title, body: digest.body },
      webpush: { headers: { Urgency: 'high', TTL: '43200' } }, // give up after 12 hours
    });
    for (const [i, response] of result.responses.entries()) {
      if (response.success) {
        sent += 1;
      } else if (DEAD_TOKEN.has(response.error?.code)) {
        await targets[i].ref.delete();
        removed += 1;
      } else {
        failed += 1;
        console.error(`Send failed: ${response.error?.code ?? response.error}`);
      }
    }
  }
}

// Names and chores are deliberately not logged: workflow logs may be public.
console.log(`Flats: ${flats.size}, reminders sent: ${sent}, failed: ${failed}, stale devices removed: ${removed}`);
if (failed && !sent) process.exit(1);
