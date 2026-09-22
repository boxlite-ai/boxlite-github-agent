// GitHub REST as the @botlite machine user. Auth is a classic PAT on that account with the
// `notifications` + `public_repo` scopes — the notifications API accepts only classic scopes
// (`X-Accepted-Oauth-Scopes: notifications, repo`), so a fine-grained token can't poll mentions.
// `fetchImpl` is injectable for tests.
const API = 'https://api.github.com'

export function github(token, { fetchImpl = fetch } = {}) {
  function request(method, path, { body, headers = {} } = {}) {
    return fetchImpl(path.startsWith('https://') ? path : `${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'boxlite-github-agent',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  /** JSON call that throws with method + path + status on a non-2xx, so a failure names the operation. */
  async function json(method, path, opts) {
    const res = await request(method, path, opts)
    if (!res.ok) {
      const err = new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    return res.status === 204 || res.status === 205 ? null : res.json()
  }

  return { request, json }
}
