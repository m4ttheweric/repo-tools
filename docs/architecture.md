# Architecture: where the design docs live

rt is one piece of a larger plan that spans five repos. Because it spans repos,
the governing documents do **not** live in any one of them. They live in Linear,
in the `mattstack` workspace.

Read these before proposing anything about rt's scope, mr-board's shape, glance,
gitq, or the acme skills:

- **[distribution roadmap: status for agents](https://linear.app/mattstack/document/distribution-roadmap-status-for-agents-017c24a92fcf)**
  The live status snapshot: phases with per-phase state, the settled rulings
  (suite-only install, no rung ladder, rt always present, pipeline-state
  design), and what is deliberately last. Start here for "what's next."

- **[rt as substrate: architecture and 8-step roadmap](https://linear.app/mattstack/document/rt-as-substrate-architecture-and-8-step-roadmap-d4c19c8c7cf2)**
  The Substrate / Wrapper / Adapter taxonomy, the six seams, the target repo
  shape, the 8-step migration order with per-step status, and the explicit
  non-goals. This is the governing document.

- **[mattstack org migration](https://linear.app/mattstack/document/mattstack-org-migration-2302dc030afc)**
  The GitHub org and npm scope consolidation, the glance extraction, and the
  `@mattstack/rt-client` design.

Tracking lives in the same workspace, one project per repo (`rt`, `rt client`,
`glance`, `mr-board`, `gitq`, `skills`) on team `just matt` (MAT).

## Why they are not in this repo

The roadmap has been lost twice: first as an unpublished artifact that existed
only in a session transcript, then as a memory under one cswap profile that the
default profile cannot read. Both were storage failures. `.local-dev/` would be
a third, since it is gitignored and therefore exists on one machine with no
backup.

Per-feature specs still belong in `.local-dev/`. That convention is right for
scaffolding that dies with the feature. Only the cross-repo roadmap moved.
