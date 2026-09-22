import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxName, snapshotPath, contextKey, boxSpec, ensureBox, runTurn } from '../src/session.mjs'

const cfg = {
  image: 'node', cpus: 2, memoryMib: 4096, volume: 'botlite-context', boxDeleteSec: 15,
  contextSecret: 'master', jobTimeoutMs: 60_000, model: undefined,
}
const req = { repo: 'acme/app', number: 7, isPR: true }
const via = { jobToken: 'job.token.sig', proxyUrl: 'https://8788-d-abc.proxy.boxlite.ai' }

test('naming: one stable box, snapshot path and context key per thread', () => {
  assert.equal(boxName('acme/app#7'), boxName('acme/app#7'))
  assert.notEqual(boxName('acme/app#7'), boxName('acme/app#8'))
  assert.match(boxName('acme/app#7'), /^botlite-[0-9a-f]{20}$/)
  assert.equal(snapshotPath('acme/app#7'), '/vol/sessions/acme/app/7/context.sealed')
  assert.equal(Buffer.from(contextKey('master', 'acme/app#7'), 'base64').length, 32)
  assert.notEqual(contextKey('master', 'acme/app#7'), contextKey('master', 'acme/app#8'))
})

test('boxSpec: shared volume, no credentials of any kind, private, self-cleaning', () => {
  const spec = boxSpec('botlite-x', cfg)
  assert.deepEqual(spec.volumes, [{ managed_volume: 'botlite-context', guest_path: '/vol' }])
  assert.equal('secrets' in spec, false) // the model is reached through the controller
  assert.deepEqual(spec.network, { mode: 'enabled' })
  // BoxLite counts seconds, 0 = off: the controller stops the box itself, and a stopped box goes
  // 15 s later (its context is on the volume). A set auto_delete must exceed auto_stop, or it's a 400.
  assert.equal(spec.auto_stop, 0)
  assert.equal(spec.auto_delete, 15)
  assert.equal('env' in spec, false) // nothing sensitive in plaintext box env
  assert.equal('auto_remove' in spec, false) // rejected (400) by the current API
})

function fakeBoxlite(over = {}) {
  const calls = []
  const rec = (name, ret) => async (...a) => (calls.push([name, ...a]), typeof ret === 'function' ? ret(...a) : ret)
  return {
    calls,
    getBox: rec('getBox', null),
    createBox: rec('createBox', { id: 'box-1', name: 'n' }),
    stopBox: rec('stopBox', null),
    startBox: rec('startBox', null),
    startExec: rec('startExec', { execution_id: 'ex-1' }),
    attach: rec('attach', 0),
    ...over,
  }
}

test('ensureBox: reuses the thread box by name, creates it otherwise', async () => {
  const found = fakeBoxlite({ getBox: async () => ({ id: 'box-9' }) })
  assert.deepEqual(await ensureBox(found, 'botlite-x', cfg), { id: 'box-9' })
  const missing = fakeBoxlite()
  assert.deepEqual(await ensureBox(missing, 'botlite-x', cfg), { id: 'box-1', name: 'n' })
  assert.equal(missing.calls.find((c) => c[0] === 'createBox')[1].name, 'botlite-x')
})

const lines = (...objs) => objs.map((o) => JSON.stringify(o) + '\n').join('')

test('runTurn: runs the in-box runner attached, answers from the last message, stops the box', async () => {
  const bl = fakeBoxlite({
    getBox: async () => ({ id: 'box-1' }),
    attach: async (id, execId, { stdin, onStdout, onStderr }) => {
      assert.equal(stdin, 'PROMPT')
      const out = lines({ type: 'thread.started', thread_id: 'th-1' }, { type: 'item.completed', item: { type: 'agent_message', text: 'from events' } })
      onStdout(Buffer.from(out.slice(0, 17))) // a JSON line split across frames
      onStdout(Buffer.from(out.slice(17)))
      onStderr(Buffer.from('warn\n'))
      onStdout(Buffer.from('\n' + lines({ type: 'botlite.result', code: 0, lastMessage: '  Final answer.  ' })))
      return 0
    },
  })
  const out = await runTurn({ bl, cfg, key: 'acme/app#7', req, pr: { headSha: 'abc', baseRef: 'main' }, prompt: 'PROMPT', ...via })
  assert.deepEqual(out, { sessionId: 'th-1', message: 'Final answer.', error: null, sessionLost: false, push: null, tooling: null })

  const [, boxId, exec] = bl.calls.find((c) => c[0] === 'startExec')
  assert.equal(boxId, 'box-1')
  assert.deepEqual(exec.args.slice(0, 2), ['--input-type=module', '-e'])
  assert.match(exec.args[2], /Runs INSIDE a session box/)
  assert.equal(exec.env.SNAPSHOT, '/vol/sessions/acme/app/7/context.sealed')
  assert.equal(exec.env.CONTEXT_KEY, contextKey('master', 'acme/app#7'))
  assert.deepEqual([exec.env.REPO, exec.env.NUMBER, exec.env.IS_PR, exec.env.HEAD_SHA, exec.env.BASE_REF], ['acme/app', '7', '1', 'abc', 'main'])
  assert.equal(JSON.parse(exec.env.BOTLITE_ARGS)[0], 'exec')
  assert.ok(JSON.parse(exec.env.BOTLITE_ARGS).some((a) => a.includes('https://8788-d-abc.proxy.boxlite.ai/backend-api/codex')))
  assert.equal(exec.env.BOTLITE_JOB_TOKEN, 'job.token.sig')
  assert.equal('PUSH_REF' in exec.env, false) // not a write turn: nothing to push, nowhere to push it
  assert.ok(bl.calls.some((c) => c[0] === 'stopBox' && c[1] === 'box-1'))
})

test('runTurn: a write turn starts on its base and pushes to its staging ref via the controller; the push report comes back', async () => {
  const push = { pushed: 'abc123', uncommitted: false }
  const bl = fakeBoxlite({ getBox: async () => ({ id: 'box-1', status: 'running' }), attach: async (id, e, { onStdout }) => (onStdout(Buffer.from(lines({ type: 'botlite.result', code: 0, lastMessage: 'done', push }))), 0) })
  const write = { base: 'b'.repeat(40), baseUrl: 'https://github.com/botlite/app.git', staging: 'botlite-staging/acme/app/7' }
  const out = await runTurn({ bl, cfg, key: 'acme/app#7', req, prompt: 'P', write, ...via })
  assert.deepEqual(out.push, push)
  const [, , exec] = bl.calls.find((c) => c[0] === 'startExec')
  assert.deepEqual([exec.env.BASE_SHA, exec.env.BASE_URL, exec.env.PUSH_URL, exec.env.PUSH_REF], ['b'.repeat(40), 'https://github.com/botlite/app.git', 'https://8788-d-abc.proxy.boxlite.ai/git', 'refs/heads/botlite-staging/acme/app/7'])
  assert.equal(Object.values(exec.env).some((v) => /ghs_|ghp_/.test(v)), false) // no GitHub token of any kind
})

test('runTurn: stops the box even when the attach fails', async () => {
  const bl = fakeBoxlite({ getBox: async () => ({ id: 'box-1' }), attach: async () => { throw new Error('ws dropped') } })
  await assert.rejects(runTurn({ bl, cfg, key: 'acme/app#7', req, prompt: 'P', ...via }), /ws dropped/)
  assert.ok(bl.calls.some((c) => c[0] === 'stopBox'))
})

test('runTurn: a resume whose session is gone is reported as sessionLost', async () => {
  const bl = fakeBoxlite({
    getBox: async () => ({ id: 'box-1' }),
    attach: async (id, e, { onStdout, onStderr }) => {
      onStderr(Buffer.from('Error: thread/resume: thread/resume failed: no rollout found for thread id th-1 (code -32600)\n'))
      onStdout(Buffer.from(lines({ type: 'botlite.result', code: 1 })))
      return 0
    },
  })
  const out = await runTurn({ bl, cfg, key: 'acme/app#7', req, prompt: 'P', sessionId: 'th-1', ...via })
  assert.equal(out.sessionLost, true)
  assert.equal(out.message, null)
  assert.match(out.error, /no answer \(exit 1\)/)
})

test('runTurn: a box deleted as it was reused (auto_delete, seconds after a stop) is made anew, once', async () => {
  let gone = true
  const bl = fakeBoxlite({
    getBox: async () => (gone ? { id: 'box-old', status: 'stopped' } : null),
    startExec: async (id) => {
      if (id === 'box-old') {
        gone = false // the next lookup no longer finds it
        throw Object.assign(new Error('boxlite POST /v1/boxes/box-old/exec → 404'), { status: 404 })
      }
      return { execution_id: 'ex-2' }
    },
    attach: async (id, execId, { onStdout }) => (onStdout(Buffer.from(lines({ type: 'botlite.result', code: 0, lastMessage: 'ok' }))), 0),
  })
  const out = await runTurn({ bl, cfg, key: 'acme/app#7', req, pr: null, prompt: 'P', ...via })
  assert.equal(out.message, 'ok')
  assert.deepEqual(bl.calls.filter((c) => c[0] === 'createBox').map((c) => c[1].name), [boxName('acme/app#7')])
  assert.equal(bl.calls.find((c) => c[0] === 'stopBox')[1], 'box-1') // the new box is the one stopped
})

test('runTurn: starts a stopped box before the exec; leaves a running one alone', async () => {
  for (const [status, expectStart] of [['stopped', true], ['running', false]]) {
    const bl = fakeBoxlite({ getBox: async () => ({ id: 'box-1', status }) , attach: async (id, e, { onStdout }) => (onStdout(Buffer.from(lines({ type: 'botlite.result', code: 0, lastMessage: 'ok' }))), 0) })
    await runTurn({ bl, cfg, key: 'acme/app#7', req, prompt: 'P', ...via })
    assert.equal(bl.calls.some((c) => c[0] === 'startBox'), expectStart, status)
  }
})
