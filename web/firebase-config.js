// Your Firebase project. These values identify the project; they are not
// secrets (access is governed by firestore.rules), so committing them is fine.
//
// Firebase console → Project settings → Your apps → Web app → "Config".
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// Firebase console → Project settings → Cloud Messaging → Web Push
// certificates → "Key pair". Needed for reminders; leave empty to disable them.
export const vapidKey = '';
