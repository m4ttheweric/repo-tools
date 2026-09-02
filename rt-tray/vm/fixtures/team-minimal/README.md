# team-minimal

The smallest team that exercises propagation rather than plumbing: one
tracked repo (`repos.clone`), one team-authored plugin (`plugins.install`
from the team marketplace), one team secret (decryptable by a joiner only
after the owner's `members sync` reaches the remote).

Loaded into a kept owner guest by `run/host/team-load.sh`; asserted on a
joiner by `run/guest/assert-team.sh` against `expect.json`. The secret value
here is a fixture, not a credential.
