/*
 * Schedi web booking alerts (Firebase Cloud Messaging).
 * Registered by the owner portal with scope /firebase-cloud-messaging-push-scope, so it never
 * controls pages and has no fetch handler. It only receives pushes and handles taps.
 * Alerts carry a webpush notification block, which the Firebase SDK shows as-is.
 */
var PORTAL_URL = 'https://schedi.app/login';

function alertUrl(notification) {
  var d = (notification && notification.data) || {};
  var fcm = d.FCM_MSG || {};
  var url = (fcm.fcmOptions && fcm.fcmOptions.link) || (fcm.data && fcm.data.url) || d.url || PORTAL_URL;
  return /^https:\/\/schedi\.app\//.test(url) ? url : PORTAL_URL;
}

// Added before the Firebase SDK so this handler runs first and the SDK's default one does not.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.stopImmediatePropagation();
  var url = alertUrl(event.notification);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      try {
        var u = new URL(w.url);
        // Reuse an open Schedi portal tab instead of opening another one.
        if (u.origin === 'https://schedi.app' && /^\/(login|portal)(\/|$)/.test(u.pathname) && 'focus' in w) {
          w.postMessage({ type: 'schedi-alert-opened' });
          return w.focus();
        }
      } catch (e) {}
    }
    return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
  }));
});

importScripts(
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/11.6.1/firebase-messaging-compat.js'
);

firebase.initializeApp({
  apiKey: 'AIzaSyBYKvxQQGIkBNRej33pTYcqKm8G1qTPDZ0',
  authDomain: 'siteforge-97699.firebaseapp.com',
  projectId: 'siteforge-97699',
  storageBucket: 'siteforge-97699.firebasestorage.app',
  messagingSenderId: '350589852487',
  appId: '1:350589852487:web:c7b4017d8880f0761b0a62'
});

var messaging = firebase.messaging();

// Booking alerts always include a notification, which the SDK displays. A data-only message
// (none are sent today) still gets a plain alert so iOS never counts it as a silent push.
messaging.onBackgroundMessage(function (payload) {
  if (payload && payload.notification) return;
  var data = (payload && payload.data) || {};
  return self.registration.showNotification(data.title || 'Schedi', {
    body: data.body || 'You have a booking update.',
    icon: '/assets/homescreen-icon.png',
    tag: data.tag || 'schedi-alert',
    data: { url: data.url || PORTAL_URL }
  });
});
