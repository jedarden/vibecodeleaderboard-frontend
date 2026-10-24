# Production hosting and custom domains

Verified state of the Cloudflare Pages hosting, the custom domains, and the
DNS work still required to serve the site and API on their production
hostnames. Last verified 2026-09-17.

## Deployment targets

| Target | Value |
|---|---|
| Cloudflare account | `e26f015c7ba47a6ad6219385e77072b7` |
| Pages project | `vibecodeleaderboard-frontend` (created 2026-08-14) |
| Default URL | `https://vibecodeleaderboard-frontend.pages.dev` |
| Site hostnames | `vibecodeleaderboard.com`, `www.vibecodeleaderboard.com` |
| API hostname | `api.vibecodeleaderboard.com` |

How a deploy flows: push to Forgejo `main` → Forgejo's server-side mirror to
GitHub `jedarden/vibecodeleaderboard-frontend` → GitHub push webhook to
`https://webhooks-ci.ardenone.com/vibecodeleaderboard-frontend` → Argo Events
sensor template `vibecodeleaderboard-frontend-deploy` → WorkflowTemplate
`website-build` with `repo=jedarden/vibecodeleaderboard-frontend`,
`cf-project=vibecodeleaderboard-frontend`, `build-command=true`,
`output-dir=.` → wrangler direct upload of the repo root (including
`functions/`, `_redirects`, `_routes.json`). The Pages API credential is the
cluster-managed `cloudflare-pages-secret` ExternalSecret (OpenBao path
`secret/rs-manager/iad-ci/cloudflare/pages/central`); it never enters this
repository.

## Verified state (2026-09-17)

- The Pages project exists and serves a production deployment
  (`6bf01b62`, 2026-09-17T11:59Z, direct upload, `deploy: success`):
  - `GET /` → 200, the leaderboard HTML shell
  - `GET /leaderboard.json` → 200, `application/json`
  - `GET /u/octocat` → 200 with function-injected `<title>`/OG tags, so
    `functions/u/[username].js` runs in production. The 2026-09-17 check was
    manual; `scripts/production-smoke.mjs` (`make smoke-production`) now
    fetches `/u/<SMOKE_USERNAME>` on every run and asserts the injected
    title, OG tags, and canonical link.
- All three custom domains are attached to the project, each `pending` with
  `verification_data` "CNAME record not set" and HTTP-01 validation
  (Google CA):
  - `vibecodeleaderboard.com` (attached 2026-09-17T08:27Z)
  - `www.vibecodeleaderboard.com` (attached 2026-09-17T08:27Z)
  - `api.vibecodeleaderboard.com` (attached 2026-09-17T10:42Z)
- Functions are host-gated (ADR-003): API routes answer only on `api.*`
  hostnames (plus `localhost` under `wrangler pages dev`). On
  `*.pages.dev` and the site hostnames those paths serve the SPA shell. The
  production API is therefore unreachable until `api.` DNS is live — that is
  the only remaining hosting gap.
- Argo deploy wiring is present in `declarative-config` (the
  `vibecodeleaderboard-frontend` github-webhooks eventsource entry and the
  website-build sensor template), and the `cloudflare-pages-secret`
  ExternalSecret reports `Ready=True`.

## Remaining step — DNS cutover (operator action)

The domain is registered at Spaceship and the zone is still delegated to
Spaceship nameservers (`launch1.spaceship.net`, `launch2.spaceship.net`)
with **no** A/AAAA/CNAME records for any of the three hostnames, and the
zone is not in the Cloudflare account. No agent-reachable credential can
change either side:

- the Pages API token is Pages-scoped — it can manage the project, its
  domains, and deployments, but cannot add a zone or write DNS records; and
- there is no Spaceship (or other registrar) API credential in OpenBao or
  on codinghome.

### Option A (recommended): move the zone into Cloudflare

This is what ADR-001 specified and what every other domain in the account
(`devimprint.com`, `jedarden.com`, …) already does. Pages custom domains on
same-account zones activate without hand-added records — Cloudflare creates
the CNAMEs (apex included, via flattening) and the certificate issues once
the zone is active.

1. Cloudflare dash → Add a domain → `vibecodeleaderboard.com` → Free plan;
   note the assigned `*.ns.cloudflare.com` pair.
2. **Recreate the live mail records in the new zone before switching.** The
   zone currently carries Spaceship email records that stop resolving the
   moment the delegation moves:
   - MX: `0 mx1.spacemail.com.` and `0 mx2.spacemail.com.`
   - TXT (SPF): `v=spf1 include:spf.spacemail.com ~all`
3. Spaceship panel → the domain → Nameservers → replace
   `launch1/launch2.spaceship.net` with the assigned pair.
4. Wait for the zone to go `active` (minutes to a few hours). The three
   Pages domains should then flip to `active` and their certificates issue;
   if one stays pending, re-check it in the dash (Activate) or by re-adding
   it via the Pages domains endpoint.

### Option B (alternative): stay on Spaceship DNS

Add records at Spaceship and let the attached domains validate over HTTP:

- `www` CNAME → `vibecodeleaderboard-frontend.pages.dev`
- `api` CNAME → `vibecodeleaderboard-frontend.pages.dev`
- apex: ALIAS/ANAME → `vibecodeleaderboard-frontend.pages.dev` (requires
  Spaceship ALIAS-at-apex support; a plain apex CNAME is not valid DNS)

The mail records are untouched. This keeps the domain off the org-standard
Cloudflare DNS and makes the apex hostname depend on Spaceship's ALIAS
implementation, which is why Option A is preferred.

## Post-cutover verification

```bash
dig +short NS vibecodeleaderboard.com          # Option A: the ns.cloudflare.com pair
dig +short CNAME api.vibecodeleaderboard.com   # -> vibecodeleaderboard-frontend.pages.dev
curl -fsS https://vibecodeleaderboard.com/leaderboard.json | head -c 120; echo
curl -fsS https://www.vibecodeleaderboard.com/ | grep -o '<title>[^<]*</title>'
curl -fsS https://api.vibecodeleaderboard.com/health   # {"status":"ok",...}
make smoke-production                                  # full site+API+SSE check
```

The Pages API (`/accounts/<account>/pages/projects/`\
`vibecodeleaderboard-frontend/domains`) reports per-domain `status: active`
once validation and the certificate complete. Until the cutover,
`make smoke-production` is expected to fail on DNS — see
[`production-smoke-tests.md`](production-smoke-tests.md) for its contract
and overrides.
