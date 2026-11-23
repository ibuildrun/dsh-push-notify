import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONFIG,
  TAGS,
  apply,
  buildApprovalMessage,
  buildQuestionMessage,
  buildTurnEndMessage,
  createNotifier,
  normalizeConfig,
  normalizeUrl,
  projectLabel,
  resolveToken,
  squash,
} from '../lib/index.js'

/** Let the fire-and-forget sender settle after a hook has run. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A fake fetch that records calls and resolves with the given response. */
function recordingFetch(response = { ok: true, status: 200 }) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return response
  }
  return { calls, fetch }
}

/** A fake Cordis context that records the handlers a plugin registers. */
function fakeContext() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
      info() {},
    },
  }
  return { ctx, handlers, warnings }
}

test('normalizeConfig fills defaults', () => {
  const config = normalizeConfig()
  assert.equal(config.enabled, true)
  assert.equal(config.endpoint, '')
  assert.equal(config.token, '')
  assert.equal(config.tokenEnv, 'DSH_PUSH_TOKEN')
  assert.deepEqual(config.events, { turnEnd: true, approval: true, questions: true })
  assert.equal(config.title, 'DeepSeek Harness')
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.url, '/')
})

test('normalizeConfig merges partial overrides', () => {
  const config = normalizeConfig({
    endpoint: '  http://127.0.0.1:8787/push/send  ',
    events: { approval: false },
    timeoutMs: 25,
    url: '/sessions',
  })
  assert.equal(config.endpoint, 'http://127.0.0.1:8787/push/send')
  assert.equal(config.events.turnEnd, true)
  assert.equal(config.events.approval, false)
  assert.equal(config.events.questions, true)
  assert.equal(config.timeoutMs, 25)
  assert.equal(config.url, '/sessions')
})

test('normalizeConfig rejects unusable values', () => {
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig({ enabled: 0 }).enabled, false)
  assert.equal(normalizeConfig({ timeoutMs: -1 }).timeoutMs, DEFAULT_CONFIG.timeoutMs)
  assert.equal(normalizeConfig({ timeoutMs: 'soon' }).timeoutMs, DEFAULT_CONFIG.timeoutMs)
  assert.equal(normalizeConfig({ title: '   ' }).title, DEFAULT_CONFIG.title)
  assert.equal(normalizeConfig('not an object').enabled, true)
})

test('normalizeUrl keeps only same-origin paths', () => {
  assert.equal(normalizeUrl('/'), '/')
  assert.equal(normalizeUrl('  /inbox  '), '/inbox')
  assert.equal(normalizeUrl('https://elsewhere.example/'), '/')
  assert.equal(normalizeUrl('javascript:alert(1)'), '/')
  assert.equal(normalizeUrl(undefined), '/')
})

test('resolveToken prefers config over environment', () => {
  assert.equal(resolveToken({ token: 'config-token', tokenEnv: 'DSH_PUSH_TOKEN' }, { DSH_PUSH_TOKEN: 'env-token' }), 'config-token')
  assert.equal(resolveToken({ token: '   ', tokenEnv: 'DSH_PUSH_TOKEN' }, { DSH_PUSH_TOKEN: ' env-token ' }), 'env-token')
  assert.equal(resolveToken({ token: '', tokenEnv: 'CUSTOM_TOKEN' }, { CUSTOM_TOKEN: 'custom' }), 'custom')
  assert.equal(resolveToken({}, {}), '')
  assert.equal(resolveToken({ tokenEnv: 'MISSING' }, {}), '')
})

test('squash collapses markup and code fences', () => {
  assert.equal(squash('```bash\nnpm test\n```\nAll checks passed.'), 'All checks passed.')
  assert.equal(squash('**Bold** `code` <b>tag</b>  \n text'), 'Bold code tag text')
  assert.equal(squash('a'.repeat(20), 10), 'aaaaaaa...')
  assert.equal(squash(null), '')
})

test('projectLabel reads the session cwd basename', () => {
  assert.equal(projectLabel({ session: { header: { cwd: '/home/dev/projects/demo-app' } } }), 'demo-app')
  assert.equal(projectLabel({ session: { meta: { cwd: '/srv/work' } } }), 'work')
  assert.equal(typeof projectLabel(null), 'string')
  assert.ok(projectLabel(null).length > 0)
})

test('turn-end message carries the project and a short preview', () => {
  const message = buildTurnEndMessage({ project: 'demo-app', preview: 'Done: 3 files changed.' })
  assert.deepEqual(message, {
    title: 'Turn finished — demo-app',
    body: 'Done: 3 files changed.',
    tag: TAGS.turnEnd,
  })
  assert.equal(buildTurnEndMessage().title, 'Turn finished')
  assert.equal(buildTurnEndMessage().body, 'The agent finished this turn.')
  assert.equal(buildTurnEndMessage({ project: 'x', preview: '```js\ncode\n```' }).body, 'The agent finished this turn.')
  assert.ok(buildTurnEndMessage({ preview: 'x'.repeat(500) }).body.length <= 163)
})

test('approval message names the tool and the reason', () => {
  const message = buildApprovalMessage({ toolName: 'bash', reason: 'wants to run the test suite' })
  assert.equal(message.title, 'Approval needed')
  assert.equal(message.body, 'bash needs approval: wants to run the test suite')
  assert.equal(message.tag, TAGS.approval)
  assert.equal(buildApprovalMessage({}).body, 'A tool needs your approval.')
  assert.equal(buildApprovalMessage(null).tag, TAGS.approval)
})

test('question message carries the first question', () => {
  const message = buildQuestionMessage({ questions: [{ header: 'Plan', question: 'Deploy to staging?' }] })
  assert.equal(message.title, 'Question waiting')
  assert.equal(message.body, 'Deploy to staging?')
  assert.equal(message.tag, TAGS.questions)
  assert.equal(buildQuestionMessage({}).body, 'The agent is waiting for your answer.')
})

test('tags are stable per event kind and distinct between kinds', () => {
  assert.equal(buildTurnEndMessage({ project: 'a' }).tag, buildTurnEndMessage({ project: 'b' }).tag)
  assert.equal(buildApprovalMessage({ toolName: 'a' }).tag, buildApprovalMessage({ toolName: 'b' }).tag)
  assert.equal(buildQuestionMessage({ questions: [{ question: 'a' }] }).tag, buildQuestionMessage({ questions: [{ question: 'b' }] }).tag)
  assert.equal(new Set(Object.values(TAGS)).size, 3)
})

test('notifier does nothing when disabled or without an endpoint', async () => {
  const disabled = recordingFetch()
  const disabledNotifier = createNotifier(normalizeConfig({ enabled: false, endpoint: 'http://127.0.0.1:8787/push/send' }), {
    fetch: disabled.fetch,
    env: {},
  })
  assert.equal(await disabledNotifier.send(buildTurnEndMessage({ project: 'demo' })), false)
  assert.equal(disabled.calls.length, 0)

  const unconfigured = recordingFetch()
  const unconfiguredNotifier = createNotifier(normalizeConfig({ endpoint: '' }), { fetch: unconfigured.fetch, env: {} })
  assert.equal(await unconfiguredNotifier.send(buildTurnEndMessage({ project: 'demo' })), false)
  assert.equal(unconfigured.calls.length, 0)
})

test('notifier posts the message with the configured token', async () => {
  const fake = recordingFetch()
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send', token: 'config-token' }), {
    fetch: fake.fetch,
    env: {},
  })
  assert.equal(await notifier.send(buildApprovalMessage({ toolName: 'bash' })), true)
  assert.equal(fake.calls.length, 1)
  const { url, init } = fake.calls[0]
  assert.equal(url, 'http://127.0.0.1:8787/push/send')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer config-token')
  const payload = JSON.parse(init.body)
  assert.deepEqual(Object.keys(payload).sort(), ['body', 'tag', 'title', 'url'])
  assert.equal(payload.title, 'Approval needed')
  assert.equal(payload.url, '/')
  assert.ok(init.signal instanceof AbortSignal)
})

test('notifier falls back to the environment token', async () => {
  const fake = recordingFetch()
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send' }), {
    fetch: fake.fetch,
    env: { DSH_PUSH_TOKEN: 'env-token' },
  })
  assert.equal(await notifier.send(buildQuestionMessage({ questions: [{ question: 'Continue?' }] })), true)
  assert.equal(fake.calls[0].init.headers.authorization, 'Bearer env-token')
})

test('notifier omits the authorization header when no token is configured', async () => {
  const fake = recordingFetch()
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send' }), { fetch: fake.fetch, env: {} })
  assert.equal(await notifier.send(buildTurnEndMessage()), true)
  assert.equal(fake.calls[0].init.headers.authorization, undefined)
})

test('notifier clamps the payload and the click target', async () => {
  const fake = recordingFetch()
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send', token: 'x', url: '/inbox' }), {
    fetch: fake.fetch,
    env: {},
  })
  await notifier.send({ title: 't'.repeat(500), body: 'b'.repeat(900), tag: 'g'.repeat(500), url: 'https://elsewhere.example/' })
  const payload = JSON.parse(fake.calls[0].init.body)
  assert.equal(payload.title.length, 120)
  assert.equal(payload.body.length, 400)
  assert.equal(payload.tag.length, 120)
  assert.equal(payload.url, '/')
})

test('a rejecting fetch never throws and reports failure', async () => {
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' }), {
    fetch: async () => {
      throw new Error('connection refused')
    },
    env: {},
  })
  assert.equal(await notifier.send(buildTurnEndMessage()), false)
})

test('a synchronously throwing fetch never throws', async () => {
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' }), {
    fetch: () => {
      throw new Error('sync failure')
    },
    env: {},
  })
  assert.equal(await notifier.send(buildTurnEndMessage()), false)
})

test('a timed-out request never throws', async () => {
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send', token: 'x', timeoutMs: 20 }), {
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))
      }),
    env: {},
  })
  // Keep the event loop referenced: the notifier's abort timer is unref'd so it
  // never holds the host open, and the loop must stay alive for it to fire.
  const keepAlive = setTimeout(() => {}, 500)
  try {
    assert.equal(await notifier.send(buildTurnEndMessage()), false)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('a non-2xx relay response reports failure without throwing', async () => {
  const notifier = createNotifier(normalizeConfig({ endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' }), {
    fetch: async () => ({ ok: false, status: 401 }),
    env: {},
  })
  assert.equal(await notifier.send(buildTurnEndMessage()), false)
})

test('apply does nothing when the plugin is disabled', () => {
  const { ctx, handlers } = fakeContext()
  apply(ctx, { enabled: false, endpoint: 'http://127.0.0.1:8787/push/send' })
  assert.equal(handlers.size, 0)
})

test('apply registers only the enabled event hooks', () => {
  const { ctx, handlers } = fakeContext()
  apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'x', events: { turnEnd: false, approval: true, questions: false } })
  assert.equal(typeof handlers.get('session/event'), 'function')
  assert.equal(typeof handlers.get('approval/request'), 'function')
  assert.equal(handlers.has('agent/turn-stopping'), false)
  assert.equal(handlers.has('user-questions/request'), false)
})

test('approval hook keeps the waterfall result and sends a push', async () => {
  const original = globalThis.fetch
  const fake = recordingFetch()
  globalThis.fetch = fake.fetch
  try {
    const { ctx, handlers } = fakeContext()
    apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'secret-token' })
    const outcome = await handlers.get('approval/request')({ toolName: 'bash', reason: 'run tests' }, async () => 'allowed-once')
    assert.equal(outcome, 'allowed-once')
    await flush()
    assert.equal(fake.calls.length, 1)
    const payload = JSON.parse(fake.calls[0].init.body)
    assert.equal(payload.title, 'Approval needed')
    assert.equal(payload.body, 'bash needs approval: run tests')
    assert.equal(fake.calls[0].init.headers.authorization, 'Bearer secret-token')
    assert.ok(!fake.calls[0].init.body.includes('secret-token'))
  } finally {
    globalThis.fetch = original
  }
})

test('approval hook still delegates when the push fails', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('relay down')
  }
  try {
    const { ctx, handlers } = fakeContext()
    apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' })
    const outcome = await handlers.get('approval/request')({ toolName: 'bash' }, async () => 'rejected')
    assert.equal(outcome, 'rejected')
  } finally {
    globalThis.fetch = original
  }
})

test('question hook keeps the waterfall result and sends a push', async () => {
  const original = globalThis.fetch
  const fake = recordingFetch()
  globalThis.fetch = fake.fetch
  try {
    const { ctx, handlers } = fakeContext()
    apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' })
    const answer = { answers: [{ id: 'q1', selected: ['Yes'] }] }
    const outcome = await handlers.get('user-questions/request')({ questions: [{ id: 'q1', question: 'Continue?' }] }, async () => answer)
    assert.equal(outcome, answer)
    await flush()
    assert.equal(fake.calls.length, 1)
    assert.equal(JSON.parse(fake.calls[0].init.body).title, 'Question waiting')
  } finally {
    globalThis.fetch = original
  }
})

test('turn-end hook previews the last assistant message', async () => {
  const original = globalThis.fetch
  const fake = recordingFetch()
  globalThis.fetch = fake.fetch
  try {
    const { ctx, handlers } = fakeContext()
    apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' })
    handlers.get('session/event')(
      { id: 'session-1' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'All 42 tests passed.' }] } } },
    )
    assert.equal(handlers.get('agent/turn-stopping')({ agent: { id: 'session-1', session: { header: { cwd: '/home/dev/projects/demo-app' } } } }), undefined)
    await flush()
    assert.equal(fake.calls.length, 1)
    const payload = JSON.parse(fake.calls[0].init.body)
    assert.equal(payload.title, 'Turn finished — demo-app')
    assert.equal(payload.body, 'All 42 tests passed.')
    assert.equal(payload.tag, TAGS.turnEnd)
  } finally {
    globalThis.fetch = original
  }
})

test('turn-end hook tolerates a waterfall continuation', async () => {
  const original = globalThis.fetch
  globalThis.fetch = recordingFetch().fetch
  try {
    const { ctx, handlers } = fakeContext()
    apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' })
    const outcome = handlers.get('agent/turn-stopping')({ agent: null }, () => 'next-value')
    assert.equal(outcome, 'next-value')
    await flush()
  } finally {
    globalThis.fetch = original
  }
})

test('turn-end hook never throws on an empty payload', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('relay down')
  }
  try {
    const { ctx, handlers } = fakeContext()
    apply(ctx, { endpoint: 'http://127.0.0.1:8787/push/send', token: 'x' })
    assert.doesNotThrow(() => handlers.get('agent/turn-stopping')(null))
    assert.doesNotThrow(() => handlers.get('session/event')(null, null))
    await flush()
  } finally {
    globalThis.fetch = original
  }
})
