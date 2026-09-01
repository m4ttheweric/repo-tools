# StrongDM (`rt sdm`)

`rt sdm` is a StrongDM auth-and-connect module: it logs you in, lists the
datasources you can reach, and connects you fast with friendly names.

```bash
rt sdm connect            # pick a datasource and connect (auto-logs-in if your session expired)
rt sdm status             # StrongDM auth health + connected tunnels
rt sdm connections        # list the tunnels you currently have open
rt sdm login              # log in (browser popup, terminal fallback)
rt sdm set-email <email>  # set the email rt logs in with
rt sdm refresh            # re-scan the catalog
rt sdm enrichment [init]  # show or scaffold the enrichment map
```

rt reads your resources straight from the StrongDM CLI (`sdm access catalog`
plus `sdm status`), so there is nothing to configure and no list to maintain.
Every real datasource you can reach shows up in the picker. If `rt sdm connect`
only shows recents, your session expired; it logs you back in automatically
before listing.

## Enrichment (optional, declarative)

Raw StrongDM names (`example-alpha-staging`) work as-is, but you can give them
nicer labels, group them by tier, and set connect defaults with a declarative
file you own at `~/.mattstack/rt/sdm/enrichment.jsonc`. Nothing runs to enrich;
rt just reads this JSON and overlays it on the live catalog.

Scaffold it from your current catalog, then fill in the labels:

```bash
rt sdm enrichment init    # writes the enrichment file: every resource, blank labels
rt sdm enrichment         # show the file path + how many resources are enriched vs raw
```

```jsonc
{
  // map a StrongDM resource name to a nicer label + connect metadata
  "example-alpha-staging": { "label": "alpha staging", "tier": "staging",    "db": { "schema": "public" } },
  "example-alpha-prod":    { "label": "alpha prod",    "tier": "production", "production": true }
}
```

| Field | Meaning |
|---|---|
| `label` | Shown in the picker (defaults to the raw resource name) |
| `tier` | `development` / `qa` / `staging` / `production` / anything: groups the picker |
| `production` | `true` adds a confirm guard before connecting |
| `reasonSuggestion` | Prefill for the access-request reason prompt |
| `db` | `{ database, schema, user }` hints used to verify the tunnel after connecting |

A resource missing from the file just shows its raw name and connects with
Postgres defaults. Keep the file in your own repo and copy or symlink it to
`~/.mattstack/rt/sdm/enrichment.jsonc` to share it with your team.

Teams can skip the file entirely: when the team settings store owns the
`rt.sdmEnrichment` key, its value replaces the local file wholesale.
