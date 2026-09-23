import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestFromEvent, isHelp, linkCommand, displayName, threadLabel, mentionedIds, plainText, threadLine, tsBefore, permalink, attachmentPlan } from '../src/slack-events.mjs'

const bot = { userId: 'UBOT', botId: 'BBOT', name: 'botlite' }
const payload = (event, over = {}) => ({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event, ...over })
const mention = (over = {}) => ({ type: 'app_mention', user: 'U1', text: '<@UBOT> why does CI fail?', ts: '1712345678.000100', channel: 'C1', event_ts: '1712345678.000100', ...over })

test('/link linear is a member command in channels and DMs; other users cannot be named as targets', () => {
  for (const text of ['<@UBOT> /link linear', '<@UBOT|BoxLite> /LINK LINEAR']) assert.equal(linkCommand({ text }, bot), 'linear')
  assert.equal(linkCommand({ text: '/link linear', isDM: true }, bot), 'linear')
  for (const text of ['/link linear', '<@OTHER> /link linear', '<@UBOT> explain /link linear', '<@UBOT> /linking']) assert.equal(linkCommand({ text }, bot), null)
  assert.equal(linkCommand({ text: '<@UBOT> /link linear U2' }, bot), 'linear u2') // rejected by the command handler
})

test('requestFromEvent: a mention in a channel starts a thread; one inside a thread continues it', () => {
  const top = requestFromEvent(payload(mention()), bot)
  assert.deepEqual(top, {
    id: 'C1:1712345678.000100', team: 'T1', channel: 'C1', ts: '1712345678.000100', threadTs: '1712345678.000100',
    isDM: false, user: 'U1', text: '<@UBOT> why does CI fail?', files: [], extShared: false,
  })
  const inThread = requestFromEvent(payload(mention({ ts: '1712345699.000200', thread_ts: '1712345678.000100' }), { is_ext_shared_channel: true }), bot)
  assert.equal(inThread.threadTs, '1712345678.000100')
  assert.equal(inThread.extShared, true)
})

test('requestFromEvent: anything a person sends the bot directly is a request — no mention needed', () => {
  const dm = requestFromEvent(payload({ type: 'message', channel_type: 'im', user: 'U2', text: 'hi', ts: '1.000001', channel: 'D9' }), bot)
  assert.deepEqual([dm.id, dm.isDM, dm.threadTs], ['D9:1.000001', true, '1.000001'])
  const upload = requestFromEvent(payload({ type: 'message', subtype: 'file_share', channel_type: 'im', user: 'U2', text: 'see log', ts: '2.000001', channel: 'D9', files: [{ id: 'F1', name: 'ci.log', mimetype: 'text/plain', size: 10, mode: 'hosted', url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/ci.log' }] }), bot)
  assert.deepEqual(upload.files, [{ id: 'F1', name: 'ci.log', mimetype: 'text/plain', size: 10, url: 'https://files.slack.com/files-pri/T1-F1/download/ci.log' }])
})

test('requestFromEvent: bots, ourselves, edits, other subtypes, channel chatter and malformed ids → nothing', () => {
  const cases = [
    mention({ bot_id: 'B7' }),
    mention({ user: 'UBOT' }),
    mention({ user: undefined }),
    mention({ edited: { user: 'U1', ts: '1712345679.000000' } }),
    mention({ subtype: 'message_changed' }),
    { type: 'message', channel_type: 'channel', user: 'U1', text: 'just talking', ts: '1.000001', channel: 'C1' }, // not addressed to us
    { type: 'message', channel_type: 'im', subtype: 'message_deleted', ts: '1.000001', channel: 'D9' },
    { type: 'message', channel_type: 'im', subtype: 'bot_message', bot_id: 'B7', text: 'beep', ts: '1.000001', channel: 'D9' },
    { type: 'reaction_added', user: 'U1' },
    mention({ channel: '../../etc' }),
    mention({ ts: '1712345678' }),
    mention({ thread_ts: '../x' }),
  ]
  for (const event of cases) assert.equal(requestFromEvent(payload(event), bot), null, JSON.stringify(event))
  assert.equal(requestFromEvent(payload(mention(), { team_id: 'T1/../x' }), bot), null)
  assert.equal(requestFromEvent({}, bot), null)
})

test('requestFromEvent: files Slack does not host (a Drive link) have no URL to download', () => {
  const r = requestFromEvent(payload(mention({ files: [{ id: 'F2', title: 'Spec', mode: 'external', url_private: 'https://docs.google.com/x' }] })), bot)
  assert.deepEqual(r.files, [{ id: 'F2', name: 'Spec', mimetype: '', size: 0, url: null }])
})

test('isHelp: help alone, with or without the mention, any case — not a request that starts with help', () => {
  for (const text of ['<@UBOT> help', '<@UBOT|botlite> Help!', 'help', ' /help ', '<@UBOT>help?']) assert.equal(isHelp(text, bot), true, text)
  for (const text of ['<@UBOT> help me fix the build', 'helpful', '<@UBOT> what does help do', '', null]) assert.equal(isHelp(text, bot), false, String(text))
})

test('plainText: Slack markup made readable, literal angle brackets kept', () => {
  const names = new Map([['U1', 'alice'], ['UBOT', 'botlite']])
  const text = '<@UBOT> ask <@U1> and <@U2|bob> in <#C1|general>, <!here>, <!subteam^S1|@devs>: see <https://ci.example/run/1|the run> or <https://x.dev> — a &lt;b&gt; &amp; <mailto:a@b.co|a@b.co>'
  assert.equal(plainText(text, names), '@botlite ask @alice and @bob in #general, @here, @devs: see the run (https://ci.example/run/1) or https://x.dev — a <b> & a@b.co')
  assert.equal(plainText(undefined), '')
})

test('mentionedIds, displayName, tsBefore, permalink', () => {
  assert.deepEqual(mentionedIds('<@U1> <@U2|x>', 'again <@U1>', null), ['U1', 'U2'])
  assert.equal(displayName({ id: 'U1', name: 'al', real_name: 'Alice A', profile: { display_name: 'alice' } }), 'alice')
  assert.equal(displayName({ id: 'U1', name: 'al', real_name: 'Alice A', profile: { display_name: '' } }), 'Alice A')
  assert.equal(displayName(undefined), 'someone')
  assert.equal(tsBefore('999999999.000001', '1712345678.000100'), true) // numeric, not lexical
  assert.equal(tsBefore('1712345678.000100', '1712345678.000100'), false)
  const req = { channel: 'C1', ts: '1712345699.000200', threadTs: '1712345699.000200' }
  assert.equal(permalink('https://acme.slack.com/', req), 'https://acme.slack.com/archives/C1/p1712345699000200')
  assert.equal(permalink('https://acme.slack.com', { ...req, threadTs: '1712345678.000100' }), 'https://acme.slack.com/archives/C1/p1712345699000200?thread_ts=1712345678.000100&cid=C1')
})

test("threadLabel: a thread's box is named for where, who asked first, and the day it began", () => {
  const alice = { id: 'U1', name: 'alice', profile: { display_name: 'Alice A' } }
  const thread = { threadTs: '1758537000.000100' } // 2025-09-22 10:30 UTC
  assert.equal(threadLabel({ ...thread, isDM: true }, { asker: alice }), 'dm-alice-0922')
  assert.equal(threadLabel({ ...thread, isDM: false }, { asker: alice, channel: 'backend' }), 'backend-alice-0922')
  assert.equal(threadLabel({ ...thread, isDM: false }, { asker: alice }), 'alice-0922') // Slack wouldn't name the channel
  assert.equal(threadLabel({ ...thread, isDM: false }, { asker: { id: 'U2', profile: { display_name: 'Bo' } } }), 'Bo-0922') // no handle: the display name
  assert.equal(threadLabel({ ...thread, isDM: true }, {}), 'dm-someone-0922')
})

test('threadLine: who said it — the bot itself, a person, an app — with its files', () => {
  const names = new Map([['U1', 'alice']])
  assert.deepEqual(threadLine({ ts: '1.1', user: 'U1', text: 'hi <@U1>', files: [{ name: 'a.log' }] }, names, bot), { ts: '1.1', who: '@alice', text: 'hi @alice\n[file: a.log]' })
  assert.equal(threadLine({ ts: '1.2', bot_id: 'BBOT', text: 'answer' }, names, bot).who, '@botlite (you)')
  assert.equal(threadLine({ ts: '1.3', bot_id: 'B7', bot_profile: { name: 'CI' }, text: 'failed' }, names, bot).who, 'CI (app)')
  assert.equal(threadLine({ ts: '1.4', user: 'U9', text: '' }, names, bot).who, '@U9')
})

test('attachmentPlan: safe unique names under the message ts; too many, too large and external files skipped', () => {
  const MB = 1024 * 1024
  const f = (name, size, url = 'https://files.slack.com/f') => ({ id: name, name, size, url })
  const { take, skip } = attachmentPlan(
    [f('ci.log', 10), f('../../etc/passwd', 10), f('ci.log', 10), f('big.bin', 6 * MB), f('drive', 0, null), f('a.png', 3 * MB), f('b.png', 3 * MB), f('.env', 1)],
    { ts: '1712345678.000100', maxFiles: 7, maxFileBytes: 5 * MB, maxTotalBytes: 4 * MB },
  )
  assert.deepEqual(take.map((t) => t.path), ['slack-files/1712345678.000100/ci.log', 'slack-files/1712345678.000100/passwd', 'slack-files/1712345678.000100/2-ci.log', 'slack-files/1712345678.000100/a.png'])
  assert.deepEqual(skip.map((s) => s.name), ['big.bin', 'drive', 'b.png', 'env'])
  assert.match(skip[0].why, /larger than 5.0 MB/)
  assert.match(skip[1].why, /isn't a file Slack hosts/)
  assert.match(skip[2].why, /add up to more than 4.0 MB/)
  assert.match(skip[3].why, /only the first 7 files/)
})
