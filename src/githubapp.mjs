// The GitHub App a write turn pushes with — a second App, installed only on the bot's own account
// (all repositories, so new forks are covered), with Contents: read & write, and Workflows: read &
// write if the bot may change CI. The controller mints one installation token per write turn, scoped
// to that turn's fork — with Workflows only for a fork that runs no Actions — and keeps it:
// the session box never sees it (its pushes go through the controller, gitpush.mjs). Its private
// key signs the App's JWTs here, so unlike the other credentials it can't be a BoxLite secret.
import { sign } from 'node:crypto'
import { github } from './github.mjs'

const b64u = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')

/** The App's own JWT (RS256), valid 9 minutes; `iat` is backdated for clock skew, as GitHub advises. */
export function appJwt(appId, privateKey, now = Date.now()) {
  const t = Math.floor(now / 1000)
  const head = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iat: t - 60, exp: t + 540, iss: String(appId) })}`
  return `${head}.${sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`
}

export function githubApp({ appId, privateKey, account, fetchImpl = fetch }) {
  const asApp = () => github(appJwt(appId, privateKey), { fetchImpl })
  return {
    /**
     * A token for `repo` (a repository name on `account`) that can write its contents — and its
     * workflows, when `workflows` and the installation has that permission; expires in 1 h. The
     * installation is looked up each time, so a permission granted since counts at once.
     */
    async token(repo, { workflows = false } = {}) {
      const installation = await asApp().json('GET', `/users/${account}/installation`).catch((e) => {
        throw new Error(`the push App isn't installed on @${account} (${e.message.slice(0, 120)})`)
      })
      const permissions = { contents: 'write', ...(workflows && installation.permissions?.workflows === 'write' ? { workflows: 'write' } : {}) }
      const t = await asApp().json('POST', `/app/installations/${installation.id}/access_tokens`, { body: { repositories: [repo], permissions } })
      return t.token
    },
    /** Revoke a token the moment its turn is over — no waiting out the hour. */
    revoke: (token) => github(token, { fetchImpl }).json('DELETE', '/installation/token'),
  }
}
