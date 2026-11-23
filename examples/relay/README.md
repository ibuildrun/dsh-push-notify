# dsh-push-notify relay (minimal example)

A single Node process that owns a VAPID key pair, stores browser subscriptions, serves a subscribe page with its service worker, and forwards authenticated notification requests from the `dsh-push-notify` plugin to every subscribed device.

It has no build step, no framework, and exactly one dependency: [`web-push`](https://www.npmjs.com/package/web-push).

## Requirements

- Node.js 22 or newer.
- A browser with Web Push. On iPhone/iPad: iOS/iPadOS 16.4+ and the page added to the home screen.
- A secure context for service workers: `https://` or `http://localhost`. A phone cannot subscribe through plain HTTP on a LAN address, so put a TLS reverse proxy or tunnel in front of the relay (see below).

## Run

```sh
cd examples/relay
npm install
export PUSH_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
node server.mjs
```

The relay prints its listen address and the state directory. Open `http://127.0.0.1:8787/` (or your HTTPS address) on the device you want to notify, press **Enable notifications**, and confirm with **Send test** (paste the token into the token field — it is used only for the test send).

`npm start` runs the same script. Without `web-push` installed the relay exits immediately with an install hint instead of an import stack trace.

### Reaching it from a phone

Keep the relay bound to loopback and let a TLS reverse proxy terminate HTTPS, for example Caddy with `push.example.test { reverse_proxy 127.0.0.1:8787 }`, or a private tunnel. Open the HTTPS address on the phone and add it to the home screen on iOS before enabling notifications. Never expose the relay over plain HTTP to the internet: the token travels in a request header.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUSH_TOKEN` | — (required) | Shared secret the plugin must send as `authorization: Bearer <token>`. Use a long random value. |
| `HOST` | `127.0.0.1` | Interface to bind. Put a TLS proxy in front instead of binding `0.0.0.0`. |
| `PORT` | `8787` | TCP port. |
| `RELAY_STATE_DIR` | `./state` | Directory for `vapid.json` and `subscriptions.json`. |
| `VAPID_SUBJECT` | `mailto:admin@dsh.example.test` | Contact URI passed to the push services. Set it to a real address you control. |

## Endpoints

| Method and path | Auth | Body / result |
| --- | --- | --- |
| `GET /push/key` | — | `{ ok, publicKey }` |
| `POST /push/subscribe` | — | `{ subscription, label? }` → `{ ok, count }` |
| `POST /push/unsubscribe` | — | `{ endpoint }` → `{ ok, count }` |
| `POST /push/send` | `Bearer $PUSH_TOKEN` | `{ title, body, tag, url }` → `{ ok, sent, failed, gone }` |
| `GET /` | — | The subscribe page. |
| `GET /sw.js` | — | The service worker. |
| `GET /manifest.webmanifest` | — | Web app manifest for “Add to Home Screen”. |
| `GET /icon.svg` | — | The icon used by the manifest and the page. |

`/push/send` prunes subscriptions whose push endpoint answers `404` or `410` (the device unsubscribed or the subscription expired). `title`, `body`, and `tag` are clamped (120, 400, 120 characters); `url` must be a path starting with `/`, otherwise it becomes `/`. The response `{ ok, sent, failed, gone }` counts deliveries; `ok` is `false` when at least one delivery failed.

## Point the plugin at it

In your DSH profile's `cordis.patch.yml`:

```yaml
- id: push-notify
  name: dsh-push-notify
  config:
    endpoint: https://push.example.test/push/send
    tokenEnv: DSH_PUSH_TOKEN
```

Set `DSH_PUSH_TOKEN` in the environment that launches DSH to the same value as `PUSH_TOKEN`, then restart DSH. See the repository README for the plugin installation step and the full configuration reference.

Test the relay without DSH:

```sh
curl -sS https://push.example.test/push/send \
  -H "authorization: Bearer $PUSH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"From curl","tag":"relay-test","url":"/"}'
```

## State and security

- `RELAY_STATE_DIR/vapid.json` — the VAPID key pair (created on first start, owner-only permissions). Back it up; regenerating it invalidates every existing subscription.
- `RELAY_STATE_DIR/subscriptions.json` — browser subscriptions (endpoints and keys, owner-only permissions). Treat it as a secret: anyone with these entries and the VAPID private key can send to those browsers.
- Subscription management is unauthenticated so a new device can subscribe from the page; only sending requires the token. Keep the relay on your private network or put authentication in front of it.
- Delete the state directory to reset every subscription and rotate the VAPID keys.
