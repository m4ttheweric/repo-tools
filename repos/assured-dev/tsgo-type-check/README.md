# tsgo-type-check — fast type-checking for assured-dev backend

Fast type-check for `apps/backend` using [`@typescript/native-preview`](https://github.com/microsoft/typescript-native-preview) (tsgo, ~15× faster than `tsc`) with [`tsc-baseline`](https://github.com/nicolo-ribaudo/tsc-baseline) for regression detection.

Only **new** type errors fail the run. Pre-existing errors are tracked in `backend.tsc-baseline.json` (persisted here in repo-tools).

**Zero footprint inside assured-dev** — tools are installed globally, and `link-repo-tools.ts` wires the tsconfig and baseline symlinks into `apps/backend/` via `.git/info/exclude`.

## Files

| File | Purpose |
|---|---|
| `tsgo-type-check.sh` | Main script |
| `tsconfig.backend.tsgo.json` | tsgo-specific tsconfig for `apps/backend` (symlinked in by link-repo-tools) |
| `backend.tsc-baseline.json` | Persisted baseline of pre-existing tsgo errors (symlinked in by link-repo-tools) |

## Setup (once per machine)

**1. Install tools globally:**

```bash
./tsgo-type-check.sh install-tools
```

**2. Wire symlinks into the repo** (also sets up everything else link-repo-tools manages):

```bash
bun ~/Documents/GitHub/repo-tools/link-repo-tools.ts
```

This creates:
- `apps/backend/tsconfig.tsgo.json` → `tsgo-type-check/tsconfig.backend.tsgo.json`
- `apps/backend/.tsc-baseline.json` → `tsgo-type-check/backend.tsc-baseline.json`

Both are registered in `.git/info/exclude` — git never sees them.

## Usage

```bash
# Check for new errors (run from anywhere inside the repo)
./tsgo-type-check.sh

# Save an updated baseline (e.g. after rebasing onto master)
./tsgo-type-check.sh save

# Explicit repo path
./tsgo-type-check.sh check --repo ~/Documents/GitHub/assured/assured-dev
```

## When to run `save`

- After rebasing onto master when new tsgo errors appear in upstream code
- After intentionally adding code that tsgo flags but tsc accepts
- After fixing baseline errors (baseline shrinks automatically)

Don't baseline errors you introduced — fix them instead.
