/*
 * Schedi web booking alerts (Firebase Cloud Messaging).
 * Registered by the owner portal with scope /firebase-cloud-messaging-push-scope, so it never
 * controls pages and has no fetch handler. It only receives pushes and handles taps.
 * Alerts carry a webpush notification block, which the Firebase SDK shows as-is.
 */
var PORTAL_URL = 'https://schedi.app/login';
var ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function alertData(notification) {
  var d = (notification && notification.data) || {};
  var fcm = d.FCM_MSG || {};
  var fd = fcm.data || {};
  var url = (fcm.fcmOptions && fcm.fcmOptions.link) || fd.url || d.url || PORTAL_URL;
  if (!/^https:\/\/schedi\.app\//.test(url)) url = PORTAL_URL;
  var bookingId = String(fd.bookingId || d.bookingId || '');
  if (!bookingId) { try { bookingId = new URL(url).searchParams.get('booking') || ''; } catch (e) {} }
  if (!ID_RE.test(bookingId)) bookingId = '';
  var date = String(fd.date || d.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = '';
  if (bookingId && url.indexOf('booking=') === -1) url = PORTAL_URL + '?booking=' + encodeURIComponent(bookingId);
  return { url: url, bookingId: bookingId, date: date };
}

// Ask an open portal tab to open the booking. Resolves true only if the page answers on the port, which pages
// from before the Accept / Deny pop-up never do (they only highlight the row), and frozen tabs can't.
// Kept well under a second: some browsers only let a notification click open a window for about 1 s.
var ACK_MS = 600;
function askTab(w, a) {
  return new Promise(function (resolve) {
    var done = false, ch = null;
    function finish(ok) { if (!done) { done = true; resolve(ok); } }
    try { ch = new MessageChannel(); } catch (e) { ch = null; }
    if (!ch) return finish(false);
    ch.port1.onmessage = function (ev) { finish(!!(ev.data && ev.data.ok)); };
    setTimeout(function () { finish(false); }, ACK_MS);
    try { w.postMessage({ type: 'schedi-alert-open', v: 2, bookingId: a.bookingId, date: a.date }, [ch.port2]); } catch (e) { finish(false); }
  });
}

// Added before the Firebase SDK so this handler runs first and the SDK's default one does not.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.stopImmediatePropagation();
  var a = alertData(event.notification);
  function openFresh() { return self.clients.openWindow ? self.clients.openWindow(a.url) : undefined; }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      try {
        var u = new URL(w.url);
        // Reuse an open Schedi portal tab instead of opening another one; it opens the booking itself.
        if (u.origin === 'https://schedi.app' && /^\/(login|portal)(\/|$)/.test(u.pathname) && 'focus' in w) {
          if (!a.bookingId) {
            w.postMessage({ type: 'schedi-alert-opened', bookingId: '', date: '' });
            return w.focus();
          }
          return askTab(w, a).then(function (ok) { return ok ? w.focus() : openFresh(); });
        }
      } catch (e) {}
    }
    return openFresh();
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
    data: { url: data.url || PORTAL_URL, bookingId: data.bookingId || '', date: data.date || '' }
  });
});
