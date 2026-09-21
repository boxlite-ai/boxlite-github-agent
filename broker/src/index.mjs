// BoxLite GitHub agent — webhook runner. A GitHub App webhook triggers a review; the broker
// boots a BoxLite box that runs Claude, and the box calls back to /publish. No per-repo
// workflow file, no repo secrets — the App + this Worker are the whole system.
//
//   POST /webhook      GitHub App webhook (pull_request → run; installation.deleted → forget)
//   POST /publish      box callback: post the review as @boxlite-agent[bot], reap the box
//   GET  /reviewer.mjs the in-box reviewer script (fetched + run by each box)
//   GET|POST /setup    one-time: store this installation's BoxLite + Claude keys (encrypted)
//
// Env: APP_ID, APP_PRIVATE_KEY (PKCS#8), WEBHOOK_SECRET, STORE_SECRET, BOXLITE_URL;
// KV: INSTALL_STORE.
import { BrokerError } from './claims.mjs'
import { handleSetup } from './setup.mjs'
import { handleWebhook } from './webhook.mjs'
import { handlePublish } from './publish-handler.mjs'
import REVIEWER_SRC from './reviewer.js.txt' // wrangler Text rule → imported as a string

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/reviewer.mjs') {
        return new Response(REVIEWER_SRC, { headers: { 'content-type': 'application/javascript; charset=utf-8' } })
      }
      if (url.pathname === '/setup') return await handleSetup(request, env, url)
      if (request.method === 'POST' && url.pathname === '/webhook') return await handleWebhook(request, env, url)
      if (request.method === 'POST' && url.pathname === '/publish') return await handlePublish(request, env, url)
      return json(404, { error: 'GET /setup · POST /webhook · POST /publish · GET /reviewer.mjs' })
    } catch (error) {
      const status = error instanceof BrokerError ? error.status : 500
      console.error(`[broker] ${url.pathname} → ${status}: ${error.stack || error.message}`)
      return json(status, { error: error.message })
    }
  },
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
