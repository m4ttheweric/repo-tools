# Daemon supervision: status verdicts and exit-code semantics

Phase 0 design anchor for the rt daemon stability roadmap (audit
2026-08). Tasks 9-14 of the Phase 0 plan implement this.

## launchd contract

The prod plist sets `KeepAlive = { SuccessfulExit: false }`: launchd
respawns the daemon ONLY on a non-zero exit. A zero exit means "stay
down". Every exit-code decision below follows from that single fact.

## Exit-code policy

| Path                                    | Exit | Why |
|-----------------------------------------|------|-----|
| `startDaemon()` boot throw (prod path)  | 1    | Visible + launchd relaunches. Paired with crash-loop detection so it cannot loop silently forever. |
| `shutdown` IPC/REST verb                | 0    | Intentional stop; launchd must not respawn. Records `last-exit.kind = "shutdown"`. |
| Bare OS signal SIGTERM/SIGINT/SIGHUP    | 1    | External kill (pkill, script, memory pressure); launchd SHOULD respawn. The sanctioned stop path goes through SMAppService.unregister, where the exit code is irrelevant, so exiting non-zero here does not break intended stops. |
| Crash-loop guard trips (N in M minutes) | 0 (park) | Stop the flapping; surface `crash-looping` so a human intervenes instead of launchd hammering every ~10s. |

Mechanism: a module-scope `shuttingDownViaVerb` flag is set true by the
`shutdown` verb before it calls cleanup; `gracefulExit(signal)` reads it:
set → exit(0), unset (bare signal) → exit(1).

Boot-phase gate: a module-scope `bootPhase: "booting" | "ready"` flips
to `"ready"` immediately before the `daemon ready` log. The
`unhandledRejection` handler exits(1) while `bootPhase === "booting"`
and only logs (recovers) once ready, so a boot-time stray rejection is
fatal but a steady-state one is not.

## Status verdicts

`rt daemon status` and `/api/status` classify by first match:

1. `not-installed`: SMAppService not registered.
2. `serving`: ping on rt.sock succeeds.
3. `parked`: ping fails, a live rt pid exists, and the boot breadcrumb
   phase is a flavor standoff (park). Named distinctly so the user is
   told "another flavor owns the socket", not "wedged".
4. `alive-not-serving`: ping fails but a live rt pid exists
   (`process.kill(pid,0)` on rt.pid, falling back to `lsof +D RT_DIR`
   scoped to this HOME's rt dir and filtered to exclude the calling
   process's own pid).
   Sub-detail from the breadcrumb phase: `booting` / `wedged`, or
   `quarantined` when a state.db/events.db boot-failed marker is present.
   Prints "process <pid> is running but not answering rt.sock ... rt daemon logs -t".
5. `crash-looping`: no live pid AND the kv failure record shows ≥ N
   failures within the last M minutes (N=3, M=5). Prints the last reason.
6. `boot-failed`: no live pid AND the most recent kv exit record is a
   boot throw (fewer than N failures). Prints the last reason + phase.
7. `installed-not-running`: registered, no live pid, clean/again-absent
   exit record.

## Persisted state (kv, ns `daemon-supervision`, no schema change)

- `boot-attempts` (number): incremented at the top of `runDaemon()`.
- `last-ready-at` (number, epoch ms): stamped just before `daemon ready`.
- `recent-failures` (array of `{ at, phase, reason }`, capped to 10):
  appended by the boot fatal path and by state.db/events.db boot-failed
  markers. Crash-loop = ≥ N entries newer than now − M minutes.
- `last-exit` (`{ at, kind: "shutdown" | "signal" | "boot-failed", code, reason? }`):
  written by the shutdown verb, the signal handlers, and the boot
  fatal path. Lets status distinguish "cleanly stopped" from "died".

## Boot breadcrumb

`~/.mattstack/rt/daemon-boot.json` = `{ at, pid, flavor, phase }`,
rewritten at each boot phase: `start` → `events-db` → `state-db` →
`api` → `socket` → `ready`. Lets `alive-not-serving` name where a
live-but-silent daemon is stuck even when the logs are unreadable.
Removed (or stamped `ready`) on successful boot.
