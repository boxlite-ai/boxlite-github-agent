# BoxLite token broker

A tiny stateless Cloudflare Worker that lets the **public `@boxlite` GitHub App** post
reviews from *any* installer's CI — **without ever handing out the App private key**.

The key lives only here. Each review run exchanges its GitHub Actions OIDC token for a
1-hour token scoped to just that run's repo.

```
caller's workflow (id-token: write)                 broker (this Worker)              GitHub
  core.getIDToken("<broker-url>")  ──OIDC JWT──►  POST /exchange
                                                  1. verify JWT: sig (JWKS) + iss + aud + exp   (jose)
                                                  2. owner/repo := verified `repository` claim
                                                  3. app JWT ─► GET /repos/{o}/{r}/installation ─► id
                                                  4. POST /app/installations/{id}/access_tokens
                                                     {repositories:[repo], permissions:{…}}   ─► ghs_…
                                  ◄──scoped token──  { token, expires_at, repository }
  GH_TOKEN=<token> → reviews post as @boxlite[bot]
```

## Why it's safe

The token is scoped to the repo named in the **cryptographically-verified `repository`
claim** — never to anything in the request body. A runner can only obtain an OIDC token
whose `repository` is its own repo, so **repo A can never get a token for repo B**
([`src/claims.mjs`](src/claims.mjs), unit-tested in [`test/claims.test.mjs`](test/claims.test.mjs)).

Full checklist enforced: fixed issuer (hardcoded, never derived from the token — cf.
octo-sts GHSA-h3qp-hwvr-9xcq), RS256 signature vs GitHub JWKS, `exp`, **`aud` == this
broker's URL** (anti-replay), installed-check (403 if `@boxlite` isn't on the repo), and
least-privilege minting (`pull_requests:write, checks:write, contents:read`). Modeled on
Chainguard's [octo-sts](https://github.com/octo-sts/app) with policy-free, claim-derived
scoping (à la [helaili/github-oidc-auth-app](https://github.com/helaili/github-oidc-auth-app)).

## Deploy

```bash
cd broker && npm install

# 1. Convert the App private key PKCS#1 → PKCS#8 (WebCrypto/Workers only imports PKCS#8):
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in boxlite.private-key.pem -out boxlite.pkcs8.pem

# 2. Deploy and set secrets:
npx wrangler deploy
npx wrangler secret put APP_ID              # the boxlite App's id (or client id)
npx wrangler secret put APP_PRIVATE_KEY     # paste boxlite.pkcs8.pem
npx wrangler secret put BROKER_AUDIENCE     # the Worker's public URL, e.g. https://boxlite-token-broker.<you>.workers.dev
```

`BROKER_AUDIENCE` must equal the `broker-url` callers pass to the Action — it's the
value the Worker requires as the OIDC `aud`.

## Register the App with exactly these permissions

A minted token can never exceed the App's own grant, so the `boxlite` App must have only:
**Repository → Pull requests: Read & write · Checks: Read & write · Contents: Read-only ·
Metadata: Read-only.** Set "Where can this be installed" to **Any account** (public).

## Callers use it

```yaml
permissions:
  contents: read
  pull-requests: write
  checks: write
  id-token: write            # lets the run fetch its OIDC token
steps:
  - uses: boxlite-ai/boxlite-github-agent@v1
    with:
      boxlite-api-key: ${{ secrets.BOXLITE_API_KEY }}
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      broker-url: https://boxlite-token-broker.<you>.workers.dev   # ← branded @boxlite bot, no App key needed
```

No App id/key in the caller's repo — just install `@boxlite` and add `broker-url`.

## Status

Security core is unit-tested (`npm test`, 8 cases). The JWT-verify + mint path is library
code (`jose` + `@octokit/auth-app`) but is **not** yet exercised end-to-end — do a live
run on a throwaway repo, and ideally a security review of the scoping, before trusting it.
