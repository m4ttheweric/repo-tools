# team-kitchen-sink

Everything the team scope can declare without a second live service: two
tracked private repos, two team-authored plugins plus one team-chosen plugin
from a public marketplace (`claude.marketplaces` + `claude.plugins`, team
scope: installed on the joiner, never auto-enabled), three secrets across
two domains, and a team-scope board title.

Not here yet, each needing an input the harness does not hold: a Linear key
for `mattstack.integrations.tracking`, a reachable switchboard, per-repo
`rt.roles`/`rt.intercepts` (needs the owner to have the repo cloned and
indexed first), and the team pack (served from outside
mattstack-marketplace).
