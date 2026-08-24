# mattstack marketplace

The Claude Code plugin catalog `rt` adds on every machine it sets up:

```bash
claude plugin marketplace add https://github.com/m4ttstack/mattstack-marketplace
claude plugin install mattstack@mattstack
claude plugin install fast-browser@mattstack
```

## This repo is generated

Its whole tree is published from `marketplace/` in
[`m4ttstack/rt`](https://github.com/m4ttstack/rt) by
`scripts/release/marketplace.sh`, one commit per release that changes it. Edits
made here are overwritten by the next release; change the catalog in `rt`.

## Plugin sources

Each plugin lives in its own repo and is **pinned to a commit**, so a given
catalog commit always installs the same plugin code:

```json
"source": { "source": "url", "url": "https://github.com/…", "ref": "main", "sha": "<commit>" }
```

Claude Code resolves `sha`. `ref` records which branch the pin came from, so
`marketplace.sh --refresh` can re-resolve it; bumping a pin is a reviewed commit
in `rt`, never an implicit follow-the-branch.

```bash
claude plugin install mattstack@mattstack
```
