# dsh-push-notify

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)
[![DSH plugin](https://img.shields.io/badge/dsh-plugin-purple.svg)](#compatibility)

Phone notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a finished turn, a pending approval, a waiting question — delivered as a native push notification through a small relay you host yourself.

No accounts, no third-party notification vendor, no telemetry. The plugin is a plain HTTP client; the relay is one Node process with one dependency.

## What you get

| Moment | Notification | Stable tag |
| --- | --- | --- |
| An agent finishes a turn | `Turn finished — <project>` plus a short preview of the answer | `dsh-turn` |
| A tool asks for approval | `Approval needed` plus the tool and the reason | `dsh-approval` |
| The agent asks a structured question | `Question waiting` plus the first question | `dsh-question` |

The tag is fixed per event kind, so a newer notification replaces the older one of the same kind on the phone instead of stacking up a wall of banners.

## How it works

```
┌──────────────────────────────┐
│ DeepSeek Harness (host)      │
│ plugin: dsh-push-notify      │
│  turn end / approval / Q     │
└───────────────┬──────────────┘
                │ HTTPS POST /push/send
                │ authorization: Bearer <token>
                ▼
┌──────────────────────────────┐
│ your relay                   │
│ examples/relay/server.mjs    │
│ VAPID keys + subscriptions   │
└───────────────┬──────────────┘
                │ encrypted Web Push message
                ▼
┌──────────────────────────────┐
│ browser push service         │
└───────────────┬──────────────┘
                ▼
┌──────────────────────────────┐
│ phone / desktop browser      │
│ service worker notification  │
└──────────────────────────────┘
```

The plugin posts a small JSON payload to the relay. The relay encrypts it for every subscribed browser (Web Push/VAPID) and hands it to that browser's push service. The service worker on the phone shows the notification and opens the configured path when it is tapped. Web Push payloads are end-to-end encrypted for the subscribed browser, so the push service operators forward ciphertext; your relay is the only server that sees the payload in clear.

## Requirements

- DSH host plugin API `>= 0.2.0` (declared in `dsh.engines.dsh`; the plugin uses the `agent/turn-stopping`, `approval/request`, and `user-questions/request` hooks).
- Node.js `>= 22` for the relay and the tests.
- A browser with Web Push support. On iPhone and iPad, notifications require iOS/iPadOS 16.4 or newer **and** adding the subscribe page to the home screen.

## Install

The setup has two halves: the relay that owns the push keys, and the plugin that talks to it.

### 1. Run the relay

From a checkout of this repository:

```sh
cd examples/relay
npm install          # installs web-push, the only dependency
export PUSH_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
node server.mjs
```

`examples/relay` is a complete minimal relay; read [examples/relay/README.md](examples/relay/README.md) for HTTPS, reverse-proxy, and state details. Keep the printed token: the plugin and the relay must share it.

### 2. Install the plugin

```sh
dsh plugin --profile <profile> add github:ibuildrun/dsh-push-notify
```

`dsh plugin` installs the package and appends it to the profile's bundle list. Then point the row at your relay by editing `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: push-notify
  name: dsh-push-notify
  config:
    endpoint: https://push.example.test/push/send
    tokenEnv: DSH_PUSH_TOKEN
```

`tokenEnv` names the environment variable that holds the shared token; `token` is the same value written directly into the config. The environment is read only when `token` is empty, so a config file never has to contain the secret:

```sh
export DSH_PUSH_TOKEN="<the token printed by the relay>"
dsh --profile <profile>
```

Restart DSH after setting the environment variable. An empty `endpoint` means the feature is off, so the plugin is inert until this step is done.

### 3. Subscribe the device

Open the relay's page (`http://127.0.0.1:8787/` on the same machine, or the HTTPS address of your relay) and press **Enable notifications**. On iPhone/iPad, first choose **Share → Add to Home Screen**, open the installed app, and enable notifications there. Then use **Send test** to confirm.

## Configuration

All fields are optional and live in the bundle patch row.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. `false` disables all hooks. |
| `endpoint` | string | `''` | Full send URL of the relay, e.g. `http://127.0.0.1:8787/push/send`. Empty means the feature is off. |
| `token` | string | `''` | Shared secret sent as `authorization: Bearer <token>`. |
| `tokenEnv` | string | `DSH_PUSH_TOKEN` | Environment variable read for the token when `token` is empty. |
| `events.turnEnd` | boolean | `true` | Notify when an agent finishes a turn. |
| `events.approval` | boolean | `true` | Notify when a tool requests approval. |
| `events.questions` | boolean | `true` | Notify when the agent asks a structured question. |
| `title` | string | `DeepSeek Harness` | Fallback notification title. |
| `timeoutMs` | number | `5000` | Hard timeout for one HTTP send; a slow relay cannot hold anything up. |
| `url` | string | `/` | Path opened when the notification is tapped. Non-relative URLs fall back to `/`. |

Typical row:

```yaml
- id: push-notify
  name: dsh-push-notify
  config:
    endpoint: https://push.example.test/push/send
    tokenEnv: DSH_PUSH_TOKEN
    events:
      questions: false
```

Sends are fire-and-forget with `AbortSignal.timeout(timeoutMs)` and every failure is swallowed (and optionally logged): a lost notification never fails or delays a turn. Tokens are never logged.

## Relay

The plugin does not depend on a specific server: any endpoint that accepts `POST` with `authorization: Bearer <token>` and a `{ title, body, tag, url }` JSON body works. `examples/relay` contains the reference relay. It is intentionally small:

- `GET /push/key` — `{ ok, publicKey }`, the VAPID public key for the subscribe page.
- `POST /push/subscribe` — `{ subscription, label? }`, stores the browser subscription.
- `POST /push/unsubscribe` — `{ endpoint }`, removes it.
- `POST /push/send` — requires `authorization: Bearer $PUSH_TOKEN`; accepts `{ title, body, tag, url }`; returns `{ ok, sent, failed, gone }` and prunes endpoints the push service reports as gone (`404`/`410`).
- `GET /` — the subscribe page (works as a plain page and inside an installed PWA).
- `GET /sw.js` — the service worker that shows and opens notifications.

Environment: `PUSH_TOKEN` (required), `HOST` (default `127.0.0.1`), `PORT` (default `8787`), `RELAY_STATE_DIR` (default `./state`), `VAPID_SUBJECT` (default `mailto:admin@dsh.example.test`). VAPID keys and subscriptions are stored as JSON in the state directory; delete it to reset all subscriptions.

## Security

- **Shared token.** Sending requires `authorization: Bearer <token>`; the relay compares it in constant time. It is read from the environment by both halves (`PUSH_TOKEN` for the relay, `tokenEnv`/`token` for the plugin) and is never written to logs or to the notification payload.
- **Loopback by default.** The relay binds `127.0.0.1:8787`. To reach it from a phone, put a TLS reverse proxy or tunnel in front of it; never expose plain HTTP to the internet. Web Push itself only works in a secure context (`https://` or `localhost`), and service worker registration enforces the same rule.
- **Keep the relay private.** Subscription management (`/push/key`, `/push/subscribe`, `/push/unsubscribe`) is unauthenticated by design so the page works on a new device; only sending is protected. Restrict the relay to your own devices or add authentication at the reverse proxy, otherwise someone who can reach it could subscribe their own device and receive the notifications.
- **No telemetry.** The plugin contacts exactly one URL — the configured `endpoint`. Nothing is collected, forwarded, or sold. The relay stores only VAPID keys and browser subscriptions under `RELAY_STATE_DIR`.
- **Secrets on disk.** `vapid.json` holds the VAPID private key; `subscriptions.json` holds push endpoints and their keys. Both are written with owner-only permissions. Back up `vapid.json`: regenerating it invalidates every subscription. Rotating `PUSH_TOKEN` is safe at any time — update the relay and the DSH environment together.

## Compatibility

- DSH `>= 0.2.0`. The plugin is a named host plugin (`apply` + `name` + `inject`), plain ESM, no runtime dependencies, and needs no client half: the browser side is the relay's page and service worker.
- Node.js `>= 22` for the relay and the test suite.
- Any browser with Web Push and service workers. iOS/iPadOS 16.4+, added to the home screen; desktop Chrome, Edge, Firefox, and Safari work as ordinary pages.
- Each installation needs its own relay key pair. One relay can serve several DSH installations if they share the token and you accept that every subscriber receives every notification; otherwise run one relay per installation.

## Development

```sh
node --test                          # plugin tests (no install needed)
node --check lib/index.js            # syntax check
node --check examples/relay/server.mjs
```

The relay example is the only part with a dependency:

```sh
cd examples/relay && npm install     # web-push
```

Without it, the relay exits with a clear install hint instead of crashing on import, so the repository itself stays dependency-free.

Layout:

```
lib/index.js          host plugin
cordis.patch.yml      bundle patch
test/plugin.test.mjs  node:test suite
examples/relay/       minimal relay, subscribe page, service worker
```

## License

MIT — see [LICENSE](LICENSE).
