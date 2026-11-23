/**
 * Web Push notifications for DeepSeek Harness.
 *
 * Watches the three moments a human is needed — a turn that finished, an
 * approval request, a structured question — and posts a short message to a Web
 * Push relay of your choice. The phone then shows a native notification while
 * the app is closed.
 *
 * Plain ESM with no dependencies. Every send is fire-and-forget, bounded by
 * `timeoutMs`, and swallowed on failure: a lost notification must never fail
 * or delay a turn. The module exports the Cordis plugin (`apply`, plus `name`
 * and `inject`) and the pure helpers covered by the tests.
 */

import { basename } from 'node:path'

/** Cordis plugin label. */
export const name = 'dsh-push-notify'

/** The plugin only listens to lifecycle events; it requires no services. */
export const inject = []

/**
 * Stable notification tags, one per event kind. The phone replaces a
 * notification carrying the same tag instead of stacking a new one.
 */
export const TAGS = Object.freeze({
  turnEnd: 'dsh-turn',
  approval: 'dsh-approval',
  questions: 'dsh-question',
})

/** Payload limits, mirroring the reference relay's validation. */
const LIMITS = Object.freeze({
  title: 120,
  body: 400,
  tag: 120,
  url: 2048,
})

/** Defaults; every field can be overridden from the bundle patch row. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  endpoint: '',
  token: '',
  tokenEnv: 'DSH_PUSH_TOKEN',
  events: Object.freeze({
    turnEnd: true,
    approval: true,
    questions: true,
  }),
  title: 'DeepSeek Harness',
  timeoutMs: 5000,
  url: '/',
})

/** @returns {boolean} whether `value` is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @returns {string} a trimmed string, or `''` for anything else. */
function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Sanitize a notification click target.
 *
 * Only same-origin paths are accepted: an absolute URL would let a push carry
 * the browser somewhere else, so anything not starting with `/` degrades to
 * the configured home path.
 *
 * @param {unknown} value - candidate URL from config or a message.
 * @returns {string} a path starting with `/`.
 */
export function normalizeUrl(value) {
  const url = asText(value)
  return url.startsWith('/') ? url.slice(0, LIMITS.url) : DEFAULT_CONFIG.url
}

/**
 * Merge user config over the defaults without mutating either side.
 *
 * Unknown keys are ignored, wrong types fall back to the default, and a
 * partial `events` object keeps the unspecified event kinds enabled.
 *
 * @param {unknown} config - raw row config.
 * @returns {typeof DEFAULT_CONFIG} the effective config.
 */
export function normalizeConfig(config) {
  const input = isRecord(config) ? config : {}
  const events = isRecord(input.events) ? input.events : {}
  const timeoutMs = Number(input.timeoutMs)
  const pick = (value, fallback) => (value === undefined ? fallback : Boolean(value))
  return {
    enabled: pick(input.enabled, DEFAULT_CONFIG.enabled),
    endpoint: asText(input.endpoint),
    token: asText(input.token),
    tokenEnv: asText(input.tokenEnv) || DEFAULT_CONFIG.tokenEnv,
    events: {
      turnEnd: pick(events.turnEnd, DEFAULT_CONFIG.events.turnEnd),
      approval: pick(events.approval, DEFAULT_CONFIG.events.approval),
      questions: pick(events.questions, DEFAULT_CONFIG.events.questions),
    },
    title: asText(input.title) || DEFAULT_CONFIG.title,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_CONFIG.timeoutMs,
    url: normalizeUrl(input.url),
  }
}

/**
 * Resolve the shared relay token: explicit config first, then an environment
 * variable named by `tokenEnv`. Never log the result.
 *
 * @param {Partial<typeof DEFAULT_CONFIG>} options - effective config.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string} the token, or `''` when neither source is set.
 */
export function resolveToken(options, env = process.env) {
  const source = isRecord(options) ? options : {}
  const direct = asText(source.token)
  if (direct) return direct
  const key = asText(source.tokenEnv) || DEFAULT_CONFIG.tokenEnv
  const fromEnv = env && typeof env === 'object' ? env[key] : undefined
  return asText(fromEnv)
}

/**
 * Collapse free text into one short line for a notification body: markup,
 * code fences, and whitespace runs are dropped, then the text is truncated.
 *
 * @param {unknown} text - raw text.
 * @param {number} [limit] - maximum number of characters to keep.
 * @returns {string} squashed text.
 */
export function squash(text, limit = 160) {
  let value = text === undefined || text === null ? '' : String(text)
  value = value.replace(/```[\s\S]*?```/g, ' ')
  value = value.replace(/`([^`]*)`/g, '$1')
  value = value.replace(/<[^>]{1,80}>/g, ' ')
  value = value.replace(/[*#>|]+/g, ' ')
  value = value.replace(/\s+/g, ' ').trim()
  if (limit > 0 && value.length > limit) {
    value = `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
  }
  return value
}

/**
 * Walk an arbitrary event payload and collect assistant text fragments.
 *
 * The stream encoding is owned by other packages, so a missing or renamed
 * shape degrades to an empty result instead of throwing inside a hook.
 *
 * @param {unknown} value - any payload fragment.
 * @param {number} [depth] - recursion guard.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} collected text fragments.
 */
function collectText(value, depth = 0, out = []) {
  if (depth > 8 || value === null || value === undefined) return out
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, depth + 1, out)
    return out
  }
  if (typeof value !== 'object') return out
  if (value.type === 'text-delta' && typeof value.text === 'string') {
    out.push(value.text)
    return out
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    out.push(value.text)
    return out
  }
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (child && typeof child === 'object') collectText(child, depth + 1, out)
  }
  return out
}

/**
 * Extract the committed assistant text from an `assistant/message` event.
 *
 * The committed message is preferred; the recorded stream is a fallback for
 * shapes that carry deltas only.
 *
 * @param {unknown} data - the event's `data` field.
 * @returns {string} the assistant text, possibly empty.
 */
function assistantText(data) {
  if (!isRecord(data)) return ''
  const fromMessage = collectText(data.message).join('').trim()
  if (fromMessage) return fromMessage
  return collectText(data.stream).join('').trim()
}

/**
 * Project label for a notification title: the working directory's last
 * segment, falling back to the process directory and finally to `DSH`.
 *
 * @param {unknown} agent - the agent from an event payload, if any.
 * @returns {string} a short label.
 */
export function projectLabel(agent) {
  try {
    const session = isRecord(agent) && isRecord(agent.session) ? agent.session : {}
    const header = isRecord(session.header) ? session.header : {}
    const meta = isRecord(session.meta) ? session.meta : {}
    for (const candidate of [header.cwd, meta.cwd, process.cwd()]) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        const label = basename(candidate)
        if (label) return label
      }
    }
  } catch {
    /* a hook must never throw because of a missing cwd */
  }
  return 'DSH'
}

/**
 * Build the turn-finished notification.
 *
 * @param {{ project?: string, preview?: string }} [input] - project label and
 *   the last assistant text captured during the turn.
 * @returns {{ title: string, body: string, tag: string }} notification message.
 */
export function buildTurnEndMessage(input = {}) {
  const source = isRecord(input) ? input : {}
  const project = asText(source.project)
  const preview = squash(source.preview, 160)
  return {
    title: project ? `Turn finished — ${project}` : 'Turn finished',
    body: preview || 'The agent finished this turn.',
    tag: TAGS.turnEnd,
  }
}

/**
 * Build the approval-request notification.
 *
 * @param {unknown} request - the `approval/request` payload.
 * @returns {{ title: string, body: string, tag: string }} notification message.
 */
export function buildApprovalMessage(request) {
  const source = isRecord(request) ? request : {}
  const tool = asText(source.toolName) || 'A tool'
  const reason = squash(source.reason, 160)
  return {
    title: 'Approval needed',
    body: reason ? `${tool} needs approval: ${reason}` : `${tool} needs your approval.`,
    tag: TAGS.approval,
  }
}

/**
 * Build the waiting-question notification.
 *
 * @param {unknown} request - the `user-questions/request` payload.
 * @returns {{ title: string, body: string, tag: string }} notification message.
 */
export function buildQuestionMessage(request) {
  const source = isRecord(request) ? request : {}
  const questions = Array.isArray(source.questions) ? source.questions : []
  const first = isRecord(questions[0]) ? questions[0] : {}
  const question = squash(first.question, 240) || squash(first.header, 120) || 'The agent is waiting for your answer.'
  return {
    title: 'Question waiting',
    body: question,
    tag: TAGS.questions,
  }
}

/** Truncate a value to `limit` characters, marking the cut with `...`. */
function truncate(value, limit) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
}

/** Safe one-line error description; never includes request headers. */
function describeError(error) {
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Create the HTTP sender for one effective config.
 *
 * `send` resolves to `true` when the relay accepted the notification and to
 * `false` for every other outcome — disabled, no endpoint, transport error,
 * timeout, or a non-2xx relay response. It never rejects.
 *
 * @param {Partial<typeof DEFAULT_CONFIG>} options - effective config.
 * @param {{ fetch?: typeof fetch, env?: Record<string, string | undefined>, logger?: { warn?: (message: string) => void } }} [deps]
 *   - test seams: transport, environment, logger.
 * @returns {{ send: (message: { title?: string, body?: string, tag?: string, url?: string }) => Promise<boolean> }} sender.
 */
export function createNotifier(options, deps = {}) {
  const config = isRecord(options) ? options : {}
  const injected = isRecord(deps) ? deps : {}
  const fetchImpl = typeof injected.fetch === 'function' ? injected.fetch : globalThis.fetch
  const env = injected.env ?? process.env
  const logger = injected.logger ?? null
  const configuredTimeout = Number(config.timeoutMs)
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : DEFAULT_CONFIG.timeoutMs
  const endpoint = asText(config.endpoint)
  const enabled = config.enabled !== false
  const tokenEnv = asText(config.tokenEnv) || DEFAULT_CONFIG.tokenEnv
  let warnedNoFetch = false
  let warnedNoToken = false

  function warn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message)
    } catch {
      /* logging must not break a turn either */
    }
  }

  async function send(message) {
    try {
      if (!enabled || !endpoint) return false
      if (typeof fetchImpl !== 'function') {
        if (!warnedNoFetch) {
          warnedNoFetch = true
          warn('push-notify: no fetch implementation available, notifications are off')
        }
        return false
      }
      const token = resolveToken({ token: asText(config.token), tokenEnv }, env)
      if (!token && !warnedNoToken) {
        warnedNoToken = true
        warn('push-notify: no token configured, sending without an Authorization header')
      }
      const source = isRecord(message) ? message : {}
      const payload = {
        title: truncate(asText(source.title) || asText(config.title) || DEFAULT_CONFIG.title, LIMITS.title),
        body: truncate(asText(source.body), LIMITS.body),
        tag: truncate(asText(source.tag), LIMITS.tag),
        url: normalizeUrl(source.url === undefined ? config.url : source.url),
      }
      const headers = { 'content-type': 'application/json' }
      if (token) headers.authorization = `Bearer ${token}`
      // An unref'd timer bounds the request without keeping the process alive:
      // notifications are fire-and-forget and must never hold the host open.
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      const timer = controller === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
      if (timer !== undefined && typeof timer.unref === 'function') timer.unref()
      let response
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          ...(controller === undefined ? {} : { signal: controller.signal }),
        })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (response && response.ok === true) return true
      const status = response && response.status !== undefined ? response.status : 'unknown'
      warn(`push-notify: relay responded with ${status}`)
      return false
    } catch (error) {
      warn(`push-notify: notification failed (${describeError(error)})`)
      return false
    }
  }

  return { send }
}

/** Build a small ctx.logger facade that tolerates a missing logger. */
function pluginLogger(ctx) {
  const logger = isRecord(ctx) ? ctx.logger : undefined
  const emit = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](message)
    } catch {
      /* logging is best effort */
    }
  }
  return {
    warn: (message) => emit('warn', message),
    info: (message) => emit('info', message),
  }
}

/**
 * Host plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Cordis context.
 * @param {Partial<typeof DEFAULT_CONFIG>} [config] - the row's config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  if (!ctx || typeof ctx.on !== 'function') return
  const options = normalizeConfig(config)
  if (!options.enabled) return

  const logger = pluginLogger(ctx)
  const notifier = createNotifier(options, { logger })
  /** Last committed assistant text per session, for the turn-end preview. */
  const lastText = new Map()

  ctx.on('session/event', (session, event) => {
    try {
      if (!isRecord(session) || !isRecord(event) || event.type !== 'assistant/message') return
      const text = assistantText(event.data)
      if (!text) return
      lastText.set(session.id, text)
      if (lastText.size > 500) lastText.delete(lastText.keys().next().value)
    } catch {
      /* a hook must never break the session */
    }
  })

  if (options.events.turnEnd) {
    // The turn is about to close with nothing owed. The current API dispatches
    // this as a serial event (no `next`); a waterfall shape is handled too so
    // the row keeps working if the event gains a continuation.
    ctx.on('agent/turn-stopping', (payload, next) => {
      try {
        const agent = isRecord(payload) && isRecord(payload.agent) ? payload.agent : null
        const sessionId = agent && agent.id !== undefined ? agent.id : undefined
        const preview = sessionId !== undefined ? lastText.get(sessionId) : undefined
        if (sessionId !== undefined) lastText.delete(sessionId)
        void notifier.send(buildTurnEndMessage({ project: projectLabel(agent), preview }))
      } catch {
        /* a lost notification is not a failed turn */
      }
      if (typeof next === 'function') return next()
      return undefined
    })
  }

  if (options.events.approval) {
    // A tool wants a one-shot decision. Pass the request through untouched and
    // ring the phone so an approval is never missed while the window is hidden.
    ctx.on('approval/request', async (request, next) => {
      try {
        void notifier.send(buildApprovalMessage(request))
      } catch {
        /* ignore */
      }
      return typeof next === 'function' ? next() : undefined
    })
  }

  if (options.events.questions) {
    // The agent asked a structured question and waits for the human's answer.
    ctx.on('user-questions/request', async (request, next) => {
      try {
        void notifier.send(buildQuestionMessage(request))
      } catch {
        /* ignore */
      }
      return typeof next === 'function' ? next() : undefined
    })
  }
}
