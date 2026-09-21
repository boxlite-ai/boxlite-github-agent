// Minimal GitHub REST helper shared by the runner-side publisher, config loader, and
// comment upserter — one place for auth headers, the JSON-body dance, and error shaping.

export function ghHeaders(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'boxlite-github-agent',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

/**
 * Call the GitHub REST API and return parsed JSON (null for 204). Throws with
 * method+path+status+body on a non-2xx so a failure names the operation. `fetchImpl` is
 * injectable for tests; `allow404` resolves a 404 to null instead of throwing.
 */
export async function ghJson(path, { token, method = 'GET', body, fetchImpl = fetch, allow404 = false } = {}) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: ghHeaders(token, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (allow404 && res.status === 404) return null
  if (!res.ok) {
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  }
  return res.status === 204 ? null : res.json()
}
