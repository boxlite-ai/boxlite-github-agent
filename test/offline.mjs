// Preload for starting the real controller in a test (start.test.mjs): answers what it calls on
// its way to going live — GitHub, BoxLite — so it starts with no network. Only 127.0.0.1 is real.
const real = globalThis.fetch
const json = (status, body, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url)
  if (u.hostname === '127.0.0.1') return real(url, init)
  const route = `${init.method || 'GET'} ${u.hostname}${u.pathname}`
  if (route === 'GET api.github.com/user') return json(200, { login: 'botlite', id: 1 })
  if (route === 'GET api.github.com/users/root') return json(200, { login: 'root', id: 2 })
  if (route === 'GET api.github.com/notifications') return json(304, null, { 'x-poll-interval': '60' })
  if (route === 'GET api.boxlite.ai/v1/volumes') return json(200, { volumes: [{ name: 'botlite-context' }] })
  return json(404, { message: `offline: no route for ${route}` })
}
