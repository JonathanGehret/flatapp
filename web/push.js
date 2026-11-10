// Reminder notifications via Firebase Cloud Messaging (web push).
// Loaded on demand so the rest of the app works where push is unavailable.

import { getMessaging, getToken, deleteToken } from './vendor/firebase-messaging.js';
import { app } from './store.js';
import { vapidKey } from './firebase-config.js';

/** Asks for permission if needed and returns this device's push token. */
export async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for this app. Allow them in your device settings, then try again.'
      : 'Notifications were not allowed.');
  }
  const registration = await navigator.serviceWorker.ready;
  // Without a key of our own, the SDK falls back to Firebase's default key pair.
  return getToken(getMessaging(app), { ...(vapidKey ? { vapidKey } : {}), serviceWorkerRegistration: registration });
}

export async function disable() {
  await deleteToken(getMessaging(app));
}
