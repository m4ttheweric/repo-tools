# Switchboard `/v1/invites` — the team-invite relay surface

**Status:** spec, ready to implement
**Owner:** board lane (`m4ttstack/board`, `switchboard/`)
**Consumer:** rt (`lib/team/relay-client.ts`) — already written to this contract
**Authority:** MAT-379 rulings 3 + 4; `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` §6 (line 463) and ruling 3a

## Why this exists

`rt team invite` and `team.join` are built and speak this protocol today. The
deployed switchboard serves PR #1's peer-boards surface (`/boards`,
`/envelopes`, `/inbox`), which MAT-379 names as *the substrate* for the team
registry — the registry itself was never built on top. Every rt invite call
currently 404s.

This spec is the minimum surface that makes the invite flow work end to end. It
is deliberately **not** all of MAT-379 sub-project A: no team definition blobs,
no per-team owner credentials, no membership. Those layer on later. What is
here is the relay, and only the relay.

## The invariant that shapes everything

MAT-379 ruling 4, restated by the installer design as: **no field on the relay
is ever plaintext employer data.**

A full DB dump must yield opaque ids, ciphertext, an opaque creator secret hash,
and timestamps. Nothing else. Specifically the relay never sees, and must never
be given a column for:

- the team's git remote, forge host, or owner handle
- the team name or slug
- the invitee's handle
- anything derived from the above

All of that lives inside `ciphertext`, sealed client-side. The decryption key
travels in the invite code (and the landing page's URL fragment) and **never
reaches the server**. The relay cannot read what it stores, by construction —
that is the durable answer to "can I point my work account at infrastructure
Matt runs".

A reviewer should be able to check this by reading the schema alone.

## Endpoints

Base: `https://switchboard.mattstack.dev` (rt's `DEFAULT_INVITE_RELAY_URL`;
overridable per-machine with `RT_INVITE_RELAY_URL`).

No admin token. These are unauthenticated by design — an invite id is a
128-bit secret, and requiring a shared token would mean shipping one to every
prospective member before they have joined anything.

### `POST /v1/invites`

Body: `{ ciphertext: string, expiresAt: string, id?: string }`
`expiresAt` is ISO-8601 (rt sends `new Date(...).toISOString()`).

The client supplies `id` because the id is the sealed blob's AAD — it must be
fixed *before* the ciphertext can exist. The relay stores under that id; it
does not mint one.

| Condition | Response |
|---|---|
| stored | `201 {id, creatorSecret}` |
| `id` already exists | **`409`** — never overwrite, never return the existing record's `creatorSecret` |
| `id` not 32 lowercase hex | `400` |
| `ciphertext` missing/not a string | `400` |
| `expiresAt` missing/unparseable/in the past | `400` |
| body over the size cap | `413` |

`id` MUST match `/^[0-9a-f]{32}$/` — rt asserts this client-side and will
reject anything else, so a relay that accepts other shapes creates records rt
can never read back.

The 409 is load-bearing: rt maps it to `relay-id-conflict`, distinct from a
generic failure, because the fix is a fresh id rather than a retry.

`creatorSecret`: ≥32 bytes from a CSPRNG, returned **once**, at creation.
Store only a hash of it (see Storage).

### `GET /v1/invites/:id`

| Condition | Response |
|---|---|
| live and unredeemed | `200 {ciphertext}` |
| unknown id | `404` |
| expired, redeemed, or revoked | `410` |

rt treats 404 and 410 identically ("gone"), so the distinction is for
operators, not clients. Never return `expiresAt`, a redeemed flag, or any
other field: an unauthenticated GET should not confirm *why* an id is gone.

### `POST /v1/invites/:id/redeem`

Single-use, and the atomicity here is the whole point.

| Condition | Response |
|---|---|
| this caller won | `200` |
| already redeemed by anyone | **`409`** |
| unknown / expired | `404` / `410` |

MUST be a compare-and-set in one SQL statement — `UPDATE … WHERE id = ? AND
redeemed_at IS NULL`, then branch on rows-changed. A read-then-write is a race
two simultaneous redeemers can both win, which would hand one invite to two
machines. The existing peer-boards code already does this correctly for its own
invites (`098fe84`, "redeem the invite and register the board in one
transaction") — reuse that shape.

### `POST /v1/invites/:id/reply`

Body: `{ blob: string }`. The joiner posts their age public key here, sealed.

| Condition | Response |
|---|---|
| stored | `200` |
| a reply already exists | `409` — write-once |
| unknown / expired | `404` / `410` |

Unauthenticated *write*, authenticated *read* — deliberate. The joiner holds no
credential at this point; they have only the invite code. Write-once is what
stops a third party who somehow learns the id from overwriting the real
joiner's key.

### `GET /v1/invites/:id/reply`

`Authorization: Bearer <creatorSecret>`

| Condition | Response |
|---|---|
| reply present, secret matches | `200 {blob}` |
| no reply yet | `404` |
| secret missing or wrong | `401` |

rt polls this; `404` means "not yet", not an error.

### `DELETE /v1/invites/:id`

`Authorization: Bearer <creatorSecret>`

| Condition | Response |
|---|---|
| revoked | `204` |
| already gone | `404` — rt treats this as **success** |
| secret missing or wrong | `401` |

Revocation is idempotent by contract: rt's `delete()` returns normally on 404,
because an invite the relay already reaped is revoked as far as the caller is
concerned.

## Storage

```sql
CREATE TABLE invites (
  id                 TEXT PRIMARY KEY,   -- 32 lowercase hex, client-chosen
  ciphertext         TEXT NOT NULL,      -- opaque; the relay never parses this
  creator_secret_hash TEXT NOT NULL,     -- sha256 of the secret, never the secret
  expires_at         INTEGER NOT NULL,   -- epoch ms
  created_at         INTEGER NOT NULL,
  redeemed_at        INTEGER,            -- NULL until redeemed; the CAS column
  reply_blob         TEXT,               -- opaque; write-once
  reply_at           INTEGER
);
CREATE INDEX invites_expires_at ON invites (expires_at);
```

That is the whole schema, and its shape is the security argument: there is no
column an operator could read to learn who invited whom, to what, or where.

- `creator_secret_hash`, never the secret. Compare with a constant-time
  comparison over the hashes.
- Reuse the existing `/data/switchboard.sqlite` volume; this is a new table
  alongside the peer-boards ones, not a new service.
- Prune on the existing hourly `store.prune()` timer: delete where
  `expires_at < now`. Redeemed invites are pruned on the same schedule rather
  than immediately, so `410` stays distinguishable from `404` for a while.

## Limits

- `ciphertext` and `blob`: cap at 64 KB each. A team pointer is a few hundred
  bytes; anything near the cap is misuse. Over → `413`.
- Rate-limit `POST /v1/invites` per source IP. The installer design says
  "rate-limited" without a number; **10/minute** is ample for a human minting
  invites and closes bulk-storage abuse of an unauthenticated endpoint.
- Rate-limit failed `Authorization` attempts per id to make `creatorSecret`
  guessing pointless.

## Tests worth having

The existing `switchboard/__tests__/server.test.ts` is the pattern. Beyond
happy paths:

1. **Two concurrent redeems of one invite: exactly one 200, one 409.** Drive
   them genuinely in parallel — a sequential test cannot fail even with a
   read-then-write race, which makes it a non-test.
2. **`POST` with an existing id returns 409 and does not alter the stored
   record** — assert the original ciphertext and `creatorSecret` still work
   afterwards, not just the status code.
3. **A wrong `creatorSecret` cannot read a reply or delete** — 401, and the
   record survives.
4. **Reply is write-once** — second post 409, first blob intact.
5. **Expired invite**: GET 410, redeem 410, and it disappears after prune.
6. **Schema check**: assert the column list matches the table above, so a later
   change that adds a plaintext field fails a test rather than shipping. This
   is the one that enforces ruling 4 mechanically instead of by review.

## Deployment

Railway service `switchboard` in project `mattstack-switchboard`, built from
`switchboard/Dockerfile` in `m4ttstack/board`.

**Check the deploy actually moves.** The ACTIVE deployment as of 2026-08-23 is
`45de6c7` (PR #1) while `098fe84` is the newest commit touching `switchboard/`,
and later deploys show *"No changes to watched files."* Confirm the watch paths
include `switchboard/**` and `src/peer/**` before trusting a green deploy — a
relay that silently serves old code is exactly the class of failure this
program has hit repeatedly.

Also note the Dockerfile copies only `switchboard/*.ts` + `src/peer/envelope.ts`.
A new import outside those paths will build fine locally and fail in the image.

## Verification, end to end

The unit tests do not prove the flow. After deploy:

```
rt team invite --handle <someone> --team <slug>     # mints against the live relay
# then, on a second machine (or a VM):
rt setup intent join <code>  →  rt setup apply
```

Then confirm on the relay that the stored row contains no team name, no remote,
and no handle. That check is the point of the whole design; run it once against
real data rather than assuming.
