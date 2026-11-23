# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-23

### Added

- Host plugin for DeepSeek Harness that sends Web Push notifications when an
  agent finishes a turn, when a tool requests approval, and when the agent asks
  a structured question.
- Stable notification tags (`dsh-turn`, `dsh-approval`, `dsh-question`) so a
  new notification of the same kind replaces the previous one on the phone.
- Configurable relay endpoint, shared token (inline or from an environment
  variable), per-event switches, send timeout, fallback title, and notification
  click target.
- Turn-finished notifications include the project label and a short preview of
  the last assistant message.
- Fire-and-forget delivery with an abort timeout; every failure is logged at
  most and never fails or delays a turn. Tokens are never logged.
- Named host plugin exports (`apply`, `name`, `inject`), plain ESM, no runtime
  dependencies, and no client half.
- `examples/relay`: a minimal self-hosted relay with VAPID key generation and
  persistence, subscription storage, a subscribe page, a service worker, an app
  manifest, and authenticated send with expired-subscription pruning
  (`web-push` is its only dependency).
- Test suite (`node --test`) covering message builders, tag stability, token
  resolution, endpoint/enabled gating, payload clamping, and swallowed and
  aborted sends.

### Security

- Sends carry the shared token in the `authorization: Bearer` header only.
- The relay binds loopback by default, compares the token in constant time,
  and limits request bodies and payload sizes.
- The notification click target is restricted to same-origin paths.
- Documented that subscription management is unauthenticated by design and that
  the relay must not be exposed without TLS and access control.

[Unreleased]: https://github.com/ibuildrun/dsh-push-notify/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ibuildrun/dsh-push-notify/releases/tag/v0.1.0
