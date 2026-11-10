// Your Firebase project. These values identify the project; they are not
// secrets (access is governed by firestore.rules), so committing them is fine.
//
// Firebase console → Project settings → Your apps → Web app → "Config".
export const firebaseConfig = {
  apiKey: 'AIzaSyDS_SXUvKe2uJ_jCfqluTWPgFuNz5q9w_Q',
  authDomain: 'flatapp-jgehret.firebaseapp.com',
  projectId: 'flatapp-jgehret',
  storageBucket: 'flatapp-jgehret.firebasestorage.app',
  messagingSenderId: '675097243146',
  appId: '1:675097243146:web:fcd697565a6db6eba979f3',
};

// Optional. Leave empty to use Firebase's default web push key. To use your
// own: Firebase console → Project settings → Cloud Messaging → Web Push
// certificates → "Key pair". Changing it later invalidates existing tokens.
export const vapidKey = '';
