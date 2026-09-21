// One-time key capture. Installing the App brings the user to this Setup URL; they paste
// their BoxLite + Claude keys, which we encrypt into KV (store.mjs). The webhook runner reads
// them back per review. No repo writes, no repo secrets — the keys live only here, and each
// review box gets them at run time.
import { BrokerError } from './claims.mjs'
import { storeKeys } from './store.mjs'

export async function handleSetup(request, env, url) {
  if (request.method === 'GET') {
    return html(formPage(url.searchParams.get('installation_id') || ''))
  }
  const form = await request.formData()
  const installationId = form.get('installation_id')
  const boxliteKey = form.get('boxlite_key')
  const claudeToken = form.get('claude_token')
  if (!installationId || !boxliteKey || !claudeToken) {
    throw new BrokerError(400, 'installation_id, boxlite_key and claude_token are required')
  }
  await storeKeys(env, installationId, { boxliteKey, claudeToken })
  return html(donePage())
}

function html(body) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function formPage(installationId) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}
input{width:100%;padding:.6rem;margin:.3rem 0 1rem;font:inherit;box-sizing:border-box}
button{padding:.6rem 1.2rem;font:inherit;background:#6f42c1;color:#fff;border:0;border-radius:6px;cursor:pointer}
label{font-weight:600}.h{color:#57606a;font-size:.9em}</style>
<h2>📦 Connect BoxLite GitHub Agent</h2>
<p class=h>Stored encrypted, used to boot your review microVM + run Claude on your own account.
Enter them once; every PR in your installed repos is reviewed automatically after that.</p>
<form method=post>
<input type=hidden name=installation_id value="${installationId}">
<label>BoxLite org API key</label>
<input name=boxlite_key required autocomplete=off>
<label>Claude token (from <code>claude setup-token</code>, sk-ant-oat…)</label>
<input name=claude_token required autocomplete=off>
<button type=submit>Save &amp; activate</button>
</form>`
}

function donePage() {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:15px/1.5 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}
code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}</style>
<h2>✅ BoxLite is connected</h2>
<p>Your keys are saved (encrypted). Open a pull request in any installed repo — 📦 <b>BoxLite
review</b> runs automatically and posts as <code>boxlite-agent[bot]</code>. Add repos any time;
they're covered instantly, no further setup.</p>`
}
