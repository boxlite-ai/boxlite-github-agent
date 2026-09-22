import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { userLogins } from '../src/userlogins.mjs'

const kinds = { linear: 'key', notion: 'oauth', google: 'oauth' }

test('userLogins.forUser: each person gets only their own bound logins, loaded from their own files', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ul-'))
  try {
    // U1 bound Linear (a raw key) and Notion (an OAuth login); nothing for Google, nothing for U2.
    mkdirSync(path.join(dir, 'linear'), { recursive: true })
    mkdirSync(path.join(dir, 'notion'), { recursive: true })
    writeFileSync(path.join(dir, 'linear', 'U1'), 'lin_api_u1key\n')
    writeFileSync(path.join(dir, 'notion', 'U1'), JSON.stringify({ token_endpoint: 'https://t', client_id: 'c', access_token: 'a1', refresh_token: 'r1', expires_at: Date.now() + 3_600_000, linked_at: new Date().toISOString() }))

    const store = userLogins({ dir, kinds })
    const u1 = await store.forUser('U1')
    assert.equal(u1.linear.ready(), true)
    assert.equal(await u1.linear.token(), 'lin_api_u1key')
    assert.equal(u1.notion.ready(), true)
    assert.equal(await u1.notion.token(), 'a1')
    assert.equal(u1.google.ready(), false) // never bound

    const u2 = await store.forUser('U2') // bound nothing
    assert.equal(u2.linear.ready(), false)
    assert.equal(u2.notion.ready(), false)
    assert.equal(u2.google.ready(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('userLogins: a login binding picked up on the next turn; bad ids and logins refused as paths', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ul-'))
  try {
    const store = userLogins({ dir, kinds })
    assert.equal((await store.forUser('U1')).linear.ready(), false) // nothing yet

    mkdirSync(path.join(dir, 'linear'), { recursive: true })
    writeFileSync(path.join(dir, 'linear', 'U1'), 'lin_api_later')
    assert.equal((await store.forUser('U1')).linear.ready(), true) // load() re-reads each turn

    assert.equal(store.fileFor('linear', 'U0AT72MBG5U'), path.join(dir, 'linear', 'U0AT72MBG5U'))
    for (const bad of ['..', 'a/b', '', 'a b', '.']) assert.throws(() => store.fileFor('linear', bad), /bad user id/)
    assert.throws(() => store.fileFor('slack', 'U1'), /no such tool login/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
