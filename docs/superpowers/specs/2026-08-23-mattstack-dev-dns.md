# `mattstack.dev` — the DNS the invite flow needs

**Status:** ready to apply
**Owner:** Matt (Cloudflare account holds the zone; nothing configured yet)
**Blocks:** the entire "you've been invited" flow

Every hostname below is already hardcoded or specified somewhere in the estate.
None of them resolve today, which is why an invite cannot be minted or redeemed.

## Required now — the invite flow

### 1. `switchboard.mattstack.dev` → the Railway relay

rt's `DEFAULT_INVITE_RELAY_URL` (`lib/team/relay-client.ts:12`). Without it,
every `rt team invite` and every join fails at DNS.

Railway issues the exact records when the custom domain is registered — **do
not guess them**. Registering `switchboard.mattstack.dev` on the service
returned:

| Type | Name | Value | Proxy |
|---|---|---|---|
| `CNAME` | `switchboard` | `uhckapqq.up.railway.app` | **DNS only (grey cloud)** |
| `TXT` | `_railway-verify.switchboard` | `railway-verify=5b11ea3e…` (ownership) | n/a |

Two corrections to an earlier draft of this file, both found by actually
registering the domain rather than reasoning about it:

- The CNAME target is a Railway-internal routing host (`uhckapqq…`), **not**
  the service's public `switchboard-production-cda9.up.railway.app`. Pointing
  at the public domain is a plausible-looking mistake that does not work.
- There is a **second, TXT record** for ownership verification. An earlier
  draft named only the CNAME, so following it would have left the certificate
  stuck at `VALIDATING_OWNERSHIP` with no obvious cause.

**Grey cloud, not orange.** Proxying gives Cloudflare the TLS session, which
means Cloudflare terminates and can see request bodies. The relay's whole
promise (MAT-379 ruling 4) is that the operator cannot read what it stores —
the ciphertext is opaque to Cloudflare either way, but adding a second party
who sees traffic metadata weakens the claim we make to a user pointing a work
account at this. It also means Railway's own certificate is what clients
validate, one less moving part.

Railway must have the custom domain registered before it will serve a
certificate. That can be done through the API rather than the dashboard, which
also prints the records to create:

```
generate_domain(project, service, environment, domain="switchboard.mattstack.dev", port=7940)
```

Registered 2026-08-23. **Both records are live and the certificate issued
~3.5 minutes after they resolved:**

```
$ curl https://switchboard.mattstack.dev/healthz
ok
$ openssl s_client -connect switchboard.mattstack.dev:443 …
subject=CN=switchboard.mattstack.dev
issuer=C=US, O=Let's Encrypt, CN=YR1
```

The Let's Encrypt issuer (rather than a Cloudflare one) is the check that the
grey cloud actually took effect — a proxied record would show Cloudflare
terminating TLS, which is the thing this setup exists to avoid.

**After it resolves**, one check that catches the common mistake:

```
curl -sS https://switchboard.mattstack.dev/healthz     # expect: ok
```

If that returns Cloudflare's HTML error page rather than `ok`, the custom
domain was not registered on Railway.

### 2. `mattstack.dev/join` → the invite landing page

Specified in the installer design (§6, and ruling 3a): a **static** page at
`https://mattstack.dev/join#<code>` that reads the fragment client-side and
offers Download plus "Open in mattstack" (`mattstack://join/<code>`).

The fragment is the load-bearing detail. **A URL fragment is never sent to the
server** — that is why the invite key rides there rather than in a query
string. Two consequences that must survive implementation:

- The page must be **static**. Any server-side rendering that reflects the
  fragment defeats the design.
- No analytics, no third-party scripts. A script with DOM access can read
  `location.hash` and ship the team key anywhere.

Simplest hosting: **Cloudflare Pages** on the same zone.

| | |
|---|---|
| Type | `CNAME` (created by Pages when you add the custom domain) |
| Name | `@` (apex) or `www` |
| Target | the `*.pages.dev` project |
| Proxy | Orange cloud is fine here — it is a static page holding no secrets |

The apex record differs from the switchboard one on purpose: a static marketing
page benefits from Cloudflare's cache and has nothing to leak; the relay does
not and does.

Nothing consumes this page programmatically, so it can land after the relay.
The invite code still works by paste (`TeamScreen` accepts the raw code) — the
landing page is the nicety that makes a link clickable for someone who does not
have the app yet.

## Specified but not yet needed

Recorded so they are not rediscovered later. Neither blocks invites.

- **`deck.mattstack.dev`** — deck's curl installer (`deck-7`, unshipped).
  Referenced in research inventory, not in shipping code.
- **`install.mattstack.dev`** — MAT-360's installer front door
  (`curl -fsSL install.mattstack.dev | sh -s -- <invite>`). MAT-379 ruling 2
  parameterizes it with the invite. Still Backlog.

## Order to do it in

1. Register the custom domain on the Railway service.
2. Create the `switchboard` CNAME, grey cloud.
3. `curl https://switchboard.mattstack.dev/healthz` → `ok`.
4. **Only then** is it worth implementing `/v1/invites` — the spec beside this
   one — because until the name resolves there is no way to test it end to end.

The landing page can happen any time after 3.

## One caveat worth stating plainly

Pointing `switchboard.mattstack.dev` at the relay makes invites *reachable*, not
*working*. The deployed relay does not serve `/v1/invites` yet, so rt will get
404s instead of DNS failures. That is progress but not a working flow — see
`2026-08-23-switchboard-v1-invites.md` for the surface that has to exist.
