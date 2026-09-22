// A stand-in for github.com's git endpoint: `git http-backend` (CGI) over the bare repos under
// `root`, e.g. <root>/boxliteai/app.git. Records each request (and its auth) in `seen`.
import http from 'node:http'
import { spawn } from 'node:child_process'

export async function gitServer(root) {
  const seen = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://github.test')
    seen.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization })
    const cgi = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'x-access-token', // http-backend takes pushes only from an authenticated user
        REQUEST_METHOD: req.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] || '',
        CONTENT_LENGTH: String(body.length),
      },
    })
    cgi.stdin.end(body)
    const out = []
    for await (const c of cgi.stdout) out.push(c)
    const raw = Buffer.concat(out)
    const end = raw.indexOf('\r\n\r\n')
    let status = 200
    const headers = {}
    for (const line of raw.subarray(0, end).toString().split('\r\n')) {
      const [k, ...v] = line.split(':')
      if (k.toLowerCase() === 'status') status = parseInt(v.join(':'), 10)
      else headers[k.toLowerCase()] = v.join(':').trim()
    }
    res.writeHead(status, headers)
    res.end(raw.subarray(end + 4))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() }
}
