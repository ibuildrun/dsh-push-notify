#!/usr/bin/env node
/**
 * Minimal self-hosted Web Push relay for the `dsh-push-notify` plugin.
 *
 * One process, no build step, no framework. It owns a VAPID key pair, stores
 * browser subscriptions on disk, serves a small subscribe page with its
 * service worker, and forwards authenticated notification requests to every
 * subscribed device. `web-push` is the only dependency; when it is missing the
 * relay exits with an install hint instead of crashing on import.
 *
 * Run:  PUSH_TOKEN=<secret> node server.mjs
 * See:  README.md in this directory.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

/* ------------------------------------------------------------------------- */
/* Configuration                                                              */
/* ------------------------------------------------------------------------- */

/** Interface to bind. Loopback by default: put a TLS proxy in front to expose. */
const HOST = process.env.HOST || '127.0.0.1'
/** TCP port for the relay. */
const PORT = Number(process.env.PORT || 8787)
/** Directory holding VAPID keys and subscriptions. */
const STATE_DIR = resolve(process.env.RELAY_STATE_DIR || './state')
/** Shared secret expected from the plugin as `authorization: Bearer <token>`. */
const PUSH_TOKEN = (process.env.PUSH_TOKEN || '').trim()
/** VAPID subject: a contact URI for the push service operators. */
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:admin@dsh.example.test').trim()

const VAPID_FILE = join(STATE_DIR, 'vapid.json')
const SUBSCRIPTIONS_FILE = join(STATE_DIR, 'subscriptions.json')

/** Request body limit; notification payloads are tiny. */
const BODY_LIMIT = 64 * 1024
/** Title used when a sender does not provide one. */
const DEFAULT_TITLE = 'Notification'
/** Notification payload limits; the plugin clamps to the same numbers. */
const LIMITS = { title: 120, body: 400, tag: 120, url: 2048 }

/* ------------------------------------------------------------------------- */
/* State files                                                                */
/* ------------------------------------------------------------------------- */

/** Create the state directory with owner-only permissions. */
function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
}

/** Read a JSON file, returning `fallback` for a missing or malformed file. */
function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Atomically replace a JSON file with owner-only permissions. */
function writeJsonFile(path, value) {
  ensureStateDir()
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

/** @returns {boolean} whether a stored subscription has the expected shape. */
function isStoredSubscription(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.endpoint === 'string' &&
    value.endpoint.length > 0 &&
    value.keys !== null &&
    typeof value.keys === 'object' &&
    typeof value.keys.p256dh === 'string' &&
    typeof value.keys.auth === 'string'
  )
}

/** Read the subscriptions, dropping entries a partial write may have damaged. */
function readSubscriptions() {
  const parsed = readJsonFile(SUBSCRIPTIONS_FILE, [])
  return Array.isArray(parsed) ? parsed.filter(isStoredSubscription) : []
}

/** Persist the subscriptions. */
function writeSubscriptions(subscriptions) {
  writeJsonFile(SUBSCRIPTIONS_FILE, subscriptions)
}

/** Stable, non-reversible identifier for logs; endpoints are treated as secrets. */
function subscriptionId(endpoint) {
  return createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16)
}

/* ------------------------------------------------------------------------- */
/* web-push loading                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Load `web-push` lazily so a missing optional dependency produces a clear
 * install hint instead of an ESM resolution stack trace.
 *
 * @returns {Promise<any>} the web-push module.
 */
async function loadWebPush() {
  let loaded
  try {
    loaded = await import('web-push')
  } catch {
    console.error('relay: the "web-push" package is not installed.')
    console.error('relay: install the example dependencies and start the relay again:')
    console.error('relay:   cd examples/relay && npm install')
    console.error('relay:   PUSH_TOKEN=<secret> node server.mjs')
    process.exit(1)
  }
  const webpush = loaded.default ?? loaded
  if (!webpush || typeof webpush.sendNotification !== 'function' || typeof webpush.generateVAPIDKeys !== 'function') {
    console.error('relay: "web-push" is installed but does not expose the expected API.')
    process.exit(1)
  }
  return webpush
}

/**
 * Load the persisted VAPID key pair, generating and saving it on first start.
 *
 * @param {any} webpush - the loaded web-push module.
 * @returns {{ publicKey: string, privateKey: string }} the active key pair.
 */
function ensureVapid(webpush) {
  const stored = readJsonFile(VAPID_FILE, null)
  if (stored && typeof stored.publicKey === 'string' && typeof stored.privateKey === 'string') {
    webpush.setVapidDetails(VAPID_SUBJECT, stored.publicKey, stored.privateKey)
    return stored
  }
  const vapid = webpush.generateVAPIDKeys()
  writeJsonFile(VAPID_FILE, vapid)
  webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey)
  console.log(`relay: generated a VAPID key pair in ${VAPID_FILE}`)
  return vapid
}

/* ------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* ------------------------------------------------------------------------- */

/** Send a JSON response that is never cached. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Send a text response with the given content type. */
function sendText(res, status, contentType, body, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

/** Turn a thrown value into a one-line message for logs. */
function describeError(error) {
  if (error && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Read and parse a JSON request body, bounded by {@link BODY_LIMIT}.
 *
 * @throws {Error & { statusCode: number }} on oversize or malformed input.
 */
async function readJsonBody(req) {
  let total = 0
  const chunks = []
  for await (const chunk of req) {
    total += chunk.length
    if (total > BODY_LIMIT) {
      const error = new Error('request body is too large')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return raw.trim() ? JSON.parse(raw) : null
  } catch {
    const error = new Error('request body is not valid JSON')
    error.statusCode = 400
    throw error
  }
}

/** Whether the request carries the configured bearer token. */
function isAuthorized(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  if (!match) return false
  const given = Buffer.from(match[1].trim())
  const expected = Buffer.from(PUSH_TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/* ------------------------------------------------------------------------- */
/* Payload handling                                                           */
/* ------------------------------------------------------------------------- */

/** Trim and truncate a payload string field. */
function cleanText(value, limit) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

/** Keep only a same-origin click target. */
function cleanUrl(value) {
  const url = typeof value === 'string' ? value.trim() : ''
  return url.startsWith('/') ? url.slice(0, LIMITS.url) : '/'
}

/** Validate and normalize the sender's notification payload. */
function normalizePayload(body) {
  const source = body !== null && typeof body === 'object' ? body : {}
  return {
    title: cleanText(source.title, LIMITS.title) || DEFAULT_TITLE,
    body: cleanText(source.body, LIMITS.body),
    tag: cleanText(source.tag, LIMITS.tag),
    url: cleanUrl(source.url),
  }
}

/**
 * Validate the browser-supplied subscription from `subscribe`.
 *
 * @returns {{ endpoint: string, keys: { p256dh: string, auth: string } } | null}
 */
function normalizeSubscription(value) {
  if (value === null || typeof value !== 'object') return null
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim() : ''
  if (!endpoint || endpoint.length > LIMITS.url) return null
  let parsed
  try {
    parsed = new URL(endpoint)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const keys = value.keys !== null && typeof value.keys === 'object' ? value.keys : null
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null
  if (!keys.p256dh || !keys.auth || keys.p256dh.length > 512 || keys.auth.length > 512) return null
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
}

/**
 * Deliver one payload to every stored subscription.
 *
 * Expired endpoints (404/410 from the push service) are pruned; any other
 * failure is counted but does not stop the remaining deliveries.
 *
 * @returns {Promise<{ ok: boolean, sent: number, failed: number, gone: number }>}
 */
async function sendToAll(webpush, payload) {
  const subscriptions = readSubscriptions()
  if (subscriptions.length === 0) return { ok: true, sent: 0, failed: 0, gone: 0 }
  const expired = new Set()
  let sent = 0
  let failed = 0
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload),
        { TTL: 900, urgency: 'high' },
      )
      sent += 1
    } catch (error) {
      const status = error && error.statusCode
      if (status === 404 || status === 410) {
        expired.add(subscription.endpoint)
        continue
      }
      failed += 1
      console.warn(`relay: delivery to subscription ${subscriptionId(subscription.endpoint)} failed: ${status || ''} ${describeError(error)}`)
    }
  }
  if (expired.size > 0) {
    writeSubscriptions(subscriptions.filter((subscription) => !expired.has(subscription.endpoint)))
    console.log(`relay: pruned ${expired.size} expired subscription(s)`)
  }
  return { ok: failed === 0, sent, failed, gone: expired.size }
}

/* ------------------------------------------------------------------------- */
/* Routes                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Request router.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {any} webpush - the loaded web-push module.
 * @param {{ publicKey: string }} vapid - the active VAPID key pair.
 */
async function handle(req, res, webpush, vapid) {
  const url = new URL(req.url || '/', 'http://relay.invalid')
  const path = url.pathname

  if (req.method === 'GET' && path === '/') {
    return sendText(res, 200, 'text/html; charset=utf-8', SUBSCRIBE_PAGE, {
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    })
  }
  if (req.method === 'GET' && path === '/sw.js') {
    return sendText(res, 200, 'application/javascript; charset=utf-8', SERVICE_WORKER, {
      'cache-control': 'no-cache',
      'service-worker-allowed': '/',
    })
  }
  if (req.method === 'GET' && path === '/manifest.webmanifest') {
    return sendText(res, 200, 'application/manifest+json; charset=utf-8', MANIFEST)
  }
  if (req.method === 'GET' && path === '/icon.svg') {
    return sendText(res, 200, 'image/svg+xml; charset=utf-8', ICON, { 'cache-control': 'public, max-age=86400' })
  }
  if (path === '/push/key') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return sendJson(res, 200, { ok: true, publicKey: vapid.publicKey })
  }
  if (path === '/push/subscribe') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const subscription = normalizeSubscription(body && body.subscription)
    if (!subscription) return sendJson(res, 400, { ok: false, error: 'a valid subscription is required' })
    const label = cleanText(body && body.label, 120)
    const subscriptions = readSubscriptions().filter((item) => item.endpoint !== subscription.endpoint)
    subscriptions.push({
      id: subscriptionId(subscription.endpoint),
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      label,
      createdAt: new Date().toISOString(),
    })
    writeSubscriptions(subscriptions)
    console.log(`relay: subscribed ${subscriptions[subscriptions.length - 1].id}, total ${subscriptions.length}`)
    return sendJson(res, 200, { ok: true, count: subscriptions.length })
  }
  if (path === '/push/unsubscribe') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const body = await readJsonBody(req)
    const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : ''
    if (!endpoint) return sendJson(res, 400, { ok: false, error: 'an endpoint is required' })
    const remaining = readSubscriptions().filter((item) => item.endpoint !== endpoint)
    writeSubscriptions(remaining)
    console.log(`relay: unsubscribed, total ${remaining.length}`)
    return sendJson(res, 200, { ok: true, count: remaining.length })
  }
  if (path === '/push/send') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    if (!isAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    const body = await readJsonBody(req)
    const payload = normalizePayload(body)
    const result = await sendToAll(webpush, payload)
    console.log(`relay: send tag=${payload.tag || '-'} sent=${result.sent} failed=${result.failed} gone=${result.gone}`)
    return sendJson(res, 200, result)
  }
  return sendJson(res, 404, { ok: false, error: 'not found' })
}

/* ------------------------------------------------------------------------- */
/* Browser assets                                                             */
/* ------------------------------------------------------------------------- */

const SUBSCRIBE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0b1020">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Push relay">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<title>Push relay — notifications</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { display: flex; align-items: center; justify-content: center; background: #0b1020; color: #e6e9f2;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(92vw, 34rem); padding: 1.5rem 0 2.5rem; }
  h1 { margin: 0 0 .35rem; font-size: 1.45rem; }
  .lede { margin: 0; color: #9aa3b8; font-size: .92rem; }
  .status { margin: 1.1rem 0; padding: .8rem 1rem; border-radius: .6rem; background: #161c31; border: 1px solid #26304d; }
  .status.ok { border-color: #2f6f4f; color: #b9f2cf; }
  .status.err { border-color: #7a3340; color: #ffc2cb; }
  .row { display: flex; gap: .6rem; flex-wrap: wrap; margin: .85rem 0; }
  button { font: inherit; padding: .7rem 1.1rem; border-radius: .6rem; border: 0; background: #4d6bfe; color: #fff; cursor: pointer; }
  button.secondary { background: #26304d; color: #e6e9f2; }
  button:disabled { opacity: .5; cursor: default; }
  label { display: block; margin-top: 1.4rem; font-size: .85rem; color: #9aa3b8; }
  .hint { margin: .3rem 0 0; color: #6f7891; font-size: .8rem; }
  input { width: 100%; margin-top: .4rem; padding: .65rem .75rem; border-radius: .6rem; border: 1px solid #26304d;
    background: #10162a; color: #e6e9f2; font: inherit; }
  .note { margin-top: 1.6rem; padding-top: 1rem; border-top: 1px solid #26304d; color: #9aa3b8; font-size: .85rem; }
</style>
</head>
<body>
<main>
  <h1>Push notifications</h1>
  <p class="lede">Connect this device to your own push relay. Notifications arrive when a DeepSeek Harness agent finishes a turn, asks for an approval, or waits for an answer.</p>
  <div id="status" class="status">Checking this device…</div>
  <div class="row">
    <button id="enable" type="button">Enable notifications</button>
    <button id="disable" class="secondary" type="button" hidden>Disable on this device</button>
  </div>
  <label for="token">Relay token</label>
  <p class="hint">Only needed for “Send test”. Kept in this tab's session storage.</p>
  <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="PUSH_TOKEN">
  <div class="row">
    <button id="test" class="secondary" type="button">Send test</button>
  </div>
  <p class="note">iPhone and iPad: Web Push works only after <strong>Share → Add to Home Screen</strong>, and requires iOS 16.4 or newer. Open the installed app, then enable notifications there.</p>
</main>
<script>
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  var enableBtn = document.getElementById('enable');
  var disableBtn = document.getElementById('disable');
  var testBtn = document.getElementById('test');
  var tokenEl = document.getElementById('token');

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind ? 'status ' + kind : 'status';
  }

  function b64ToBytes(value) {
    var padding = new Array(((4 - (value.length % 4)) % 4) + 1).join('=');
    var normalized = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(normalized);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (response) { return response.json(); });
  }

  function registration() {
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('Service workers are unavailable — open this page over HTTPS or on localhost.'));
    return navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function () { return navigator.serviceWorker.ready; });
  }

  function refresh() {
    if (!('Notification' in window)) { setStatus('This browser does not support notifications.', 'err'); enableBtn.disabled = true; return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setStatus('Web Push is not available here. On iPhone or iPad, add this page to the home screen first.', 'err'); return; }
    registration().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (sub) { setStatus('Notifications are enabled on this device.', 'ok'); enableBtn.hidden = true; disableBtn.hidden = false; }
      else if (Notification.permission === 'denied') { setStatus('Notifications are blocked. Allow them for this site in the browser settings.', 'err'); }
      else if (Notification.permission === 'granted') { setStatus('Permission granted, but this device is not subscribed yet. Press “Enable notifications”.'); }
      else { setStatus('Notifications are not enabled yet.'); }
    }).catch(function (error) { setStatus(error && error.message ? error.message : String(error), 'err'); });
  }

  enableBtn.addEventListener('click', function () {
    enableBtn.disabled = true;
    setStatus('Requesting permission…');
    Promise.resolve(Notification.requestPermission()).then(function (permission) {
      if (permission !== 'granted') throw new Error('Permission was not granted. Enable notifications for this site in the browser settings.');
      return registration();
    }).then(function (reg) {
      return fetch('/push/key').then(function (response) { return response.json(); }).then(function (data) {
        if (!data || !data.ok || !data.publicKey) throw new Error((data && data.error) || 'The relay key is unavailable.');
        return reg.pushManager.getSubscription().then(function (existing) {
          if (existing) return existing;
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.publicKey) });
        });
      });
    }).then(function (sub) {
      return post('/push/subscribe', { subscription: sub.toJSON(), label: String(navigator.userAgent).slice(0, 120) });
    }).then(function (result) {
      if (!result || !result.ok) throw new Error((result && result.error) || 'The subscription was not saved.');
      setStatus('Notifications are enabled. Devices on this relay: ' + result.count + '.', 'ok');
      enableBtn.hidden = true; disableBtn.hidden = false; enableBtn.disabled = false;
    }).catch(function (error) { setStatus(error && error.message ? error.message : String(error), 'err'); enableBtn.disabled = false; });
  });

  disableBtn.addEventListener('click', function () {
    disableBtn.disabled = true;
    registration().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) { setStatus('There is no subscription on this device.'); return undefined; }
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () { return post('/push/unsubscribe', { endpoint: endpoint }); }).then(function () {
        setStatus('Notifications are disabled on this device.', 'ok');
        enableBtn.hidden = false; disableBtn.hidden = true;
      });
    }).catch(function (error) { setStatus(error && error.message ? error.message : String(error), 'err'); }).then(function () { disableBtn.disabled = false; });
  });

  testBtn.addEventListener('click', function () {
    testBtn.disabled = true;
    var token = tokenEl.value.trim();
    try { if (token) sessionStorage.setItem('relay-token', token); } catch (error) {}
    setStatus('Sending a test notification…');
    fetch('/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ title: 'Push relay', body: 'The relay works — this is a test notification.', tag: 'relay-test', url: '/' })
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'HTTP ' + response.status }; });
    }).then(function (result) {
      if (result && result.ok && result.sent > 0) { setStatus('Test sent to ' + result.sent + ' device(s).', 'ok'); return; }
      if (result && result.ok) { setStatus('No devices are subscribed yet — enable notifications first.', 'err'); return; }
      setStatus('The relay rejected the test: ' + ((result && result.error) || 'unknown error'), 'err');
    }).catch(function (error) { setStatus(error && error.message ? error.message : String(error), 'err'); }).then(function () { testBtn.disabled = false; });
  });

  try { var saved = sessionStorage.getItem('relay-token'); if (saved) tokenEl.value = saved; } catch (error) {}
  refresh();
})();
</script>
</body>
</html>`

const SERVICE_WORKER = `/* dsh-push-notify relay service worker: shows a notification per push and
   opens the target when the notification is clicked. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = {}; }
  var tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  var options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: tag,
    renotify: Boolean(tag),
    data: { url: typeof data.url === 'string' && data.url ? data.url : '/' }
  };
  event.waitUntil(self.registration.showNotification(
    typeof data.title === 'string' && data.title ? data.title : 'Notification',
    options
  ));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
    for (var i = 0; i < clients.length; i += 1) {
      var client = clients[i];
      if (client.url && client.url.indexOf(self.registration.scope) === 0) {
        if (client.focus) client.focus();
        if (client.navigate) client.navigate(url).catch(function () {});
        return undefined;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  }));
});
`

const MANIFEST = `${JSON.stringify(
  {
    name: 'Push relay',
    short_name: 'Push relay',
    description: 'Subscribe this device to push notifications from your relay.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b1020',
    theme_color: '#0b1020',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  },
  null,
  2,
)}\n`

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" role="img" aria-label="Push relay">
  <rect width="192" height="192" rx="42" fill="#4d6bfe"/>
  <path d="M96 40a10 10 0 0 1 10 10v7.2c18.4 4.7 31.5 21.2 31.5 40.5v20.2l9.7 15.4c2.6 4.1-.4 9.4-5.2 9.4H50c-4.8 0-7.8-5.3-5.2-9.4l9.7-15.4v-20.2C54.5 78.4 67.6 61.9 86 57.2V50a10 10 0 0 1 10-10zm0 116.5a20.4 20.4 0 0 1-19.8-15.5h39.6a20.4 20.4 0 0 1-19.8 15.5z" fill="#fff"/>
</svg>
`

/* ------------------------------------------------------------------------- */
/* Startup                                                                    */
/* ------------------------------------------------------------------------- */

async function main() {
  const webpush = await loadWebPush()
  if (!PUSH_TOKEN) {
    console.error('relay: PUSH_TOKEN is not set. It is the shared secret between the plugin and this relay.')
    console.error('relay: generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"')
    process.exit(1)
  }
  if (PUSH_TOKEN.length < 16) {
    console.warn('relay: PUSH_TOKEN is short; use a long random value and keep it out of shell history.')
  }
  const vapid = ensureVapid(webpush)

  const server = createServer((req, res) => {
    handle(req, res, webpush, vapid).catch((error) => {
      const status = error && Number.isInteger(error.statusCode) ? error.statusCode : 500
      if (status >= 500) console.error(`relay: request failed: ${describeError(error)}`)
      if (!res.headersSent) sendJson(res, status, { ok: false, error: status === 500 ? 'internal error' : describeError(error) })
      else res.destroy()
    })
  })
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  server.on('error', (error) => {
    console.error(`relay: server error: ${describeError(error)}`)
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    console.log(`relay: listening on http://${HOST}:${PORT}`)
    console.log(`relay: state directory ${STATE_DIR}`)
    console.log('relay: open the page on a device to subscribe, then point the plugin at /push/send')
  })
  const shutdown = (signal) => {
    console.log(`relay: ${signal} received, shutting down`)
    server.close(() => process.exit(0))
    // Do not hang forever on a half-open keep-alive connection.
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error(`relay: failed to start: ${describeError(error)}`)
  process.exit(1)
})
