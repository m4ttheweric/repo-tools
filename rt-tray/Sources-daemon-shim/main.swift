// rt-daemon-shim
//
// Tiny signed exec-proxy that lets the daemon run from source under launchd
// supervision. This binary IS the dev bundle's Contents/MacOS/rt
// (spec MAT-383 §3) — permanently the dev flavor's daemon launcher, never a
// swap payload dropped into the prod bundle. It execs
// `bun run <sourcePath>/lib/daemon.ts` so edits take effect on the next
// daemon restart without a release cycle.
//
// Configuration comes from ~/.mattstack/rt/state.db (RT-48/MAT-383 §9): the
// `kv` table's row where ns='dev-mode', k='config', v = JSON
// `{ "sourcePath": "/path/to/repo-tools", "bunPath": "/Users/.../.bun/bin/bun" }`.
// This table/columns/row shape is a cross-language contract — see the note
// on the `kv` table in lib/state/db.ts before changing either side.
//
// LEGACY FALLBACK: if state.db has no row yet, this also reads the retired
// ~/.mattstack/rt/dev-mode.json directly (read-only — this shim never
// migrates or writes state.db; that stays commands/settings.ts's job). The
// TS-side importer is reachable only from `rt settings dev-mode`, and this
// shim runs before bun exists, so it cannot depend on any prior rt
// invocation having migrated the file first. Without this fallback, an
// existing dev-mode machine that just picks up a new dev bundle loses its
// daemon silently on the next restart until someone happens to re-run
// `rt settings dev-mode`. Remove this fallback once enough time has passed
// that no machine still has an un-migrated dev-mode.json.
//
// TRUST: state.db is a shared multi-namespace store written by many rt code
// paths (unlike the old single-purpose dev-mode.json), so its row is only
// trusted when the file is owned by this process's uid and not group/other-
// writable — see isTrustedStateDb. Both `sourcePath` and any `bunPath` are
// required to be absolute; a relative `bunPath` is treated as absent (falls
// back to ~/.bun/bin/bun) and a relative `sourcePath` invalidates the row
// entirely (no sensible default). Even a READ-ONLY open of a WAL-mode
// state.db can create/rewrite its `-shm` sidecar, so an unwritable or
// foreign-owned ~/.mattstack/rt is itself a (silent, stand-down) precondition
// failure for daemon boot, not just for the CLI/daemon's own writes.
//
// EXIT-CODE CONTRACT (spec MAT-383 §3) — the dev agent plist sets
// KeepAlive = { SuccessfulExit = false }, which makes the exit code the only
// signal launchd has:
//
//   exit 0  — a precondition isn't met (no dev-mode config anywhere, source
//             tree moved, bun not installed). Nothing is wrong with the
//             machine; the dev flavor simply has nothing to run. launchd
//             leaves it down, and one log line says why. NOT an error, NOT
//             a crash loop. A missing state.db, a missing `kv` table, a
//             missing/corrupt/untrusted row, and a missing legacy file all
//             fold into this same path.
//   exit >0 — something genuinely unexpected failed after every precondition
//             checked out (execv into an existing bun refused). launchd
//             restarts, which is the right response to a real crash.
//
// LOGGING: fd 2 is redirected to ~/.mattstack/rt/logs/daemon-stderr.log
// BEFORE any precondition is evaluated (see the freopen call below) — the
// LaunchAgent plist deliberately omits StandardErrorPath, so without this
// redirect happening first, every stand-down message below is written to a
// fd launchd sends to /dev/null and is invisible anywhere.
//
// Signed with the same Developer ID as the rest of the dev bundle, keeping the
// `-i rt` identifier override so launchd's LWCR check accepts it.
// TCC inherits from the app bundle because the shim lives inside it.

import Darwin
import Foundation
import SQLite3

private func log(_ msg: String) {
    FileHandle.standardError.write(Data("rt-daemon-shim: \(msg)\n".utf8))
}

/// A precondition isn't met — say so once, exit cleanly (contract above).
@inline(__always)
func standDown(_ msg: String) -> Never {
    log("standing down: \(msg)")
    exit(0)
}

/// A genuine, unexpected failure — nonzero so launchd treats it as a crash.
@inline(__always)
func fail(_ msg: String) -> Never {
    log("error: \(msg)")
    exit(70) // EX_SOFTWARE
}

// sqlite3_bind_text's destructor argument: -1 cast to the function-pointer
// type it expects, telling sqlite3 to copy the string itself. Not bridged
// automatically from the C macro of the same name.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct DevModeConfig {
    let sourcePath: String
    let bunPath: String
}

/// Shared validation/defaulting both config sources (state.db row, legacy
/// JSON file) go through. `sourcePath` has no sensible default, so a
/// relative value invalidates the whole config; `bunPath` does have a
/// default, so a relative value is simply treated as absent — this shim
/// never treats a relative path as PATH-relative (`fileExists` resolves it
/// against launchd's cwd, not a shell PATH), so a non-absolute value could
/// never have worked anyway.
func finalizeConfig(sourcePathRaw: String?, bunPathRaw: String?, home: String) -> DevModeConfig? {
    guard let sourcePathRaw, sourcePathRaw.hasPrefix("/") else { return nil }
    let bunPath = (bunPathRaw?.hasPrefix("/") == true) ? bunPathRaw! : "\(home)/.bun/bin/bun"
    return DevModeConfig(sourcePath: sourcePathRaw, bunPath: bunPath)
}

/// Refuses to trust state.db's contents unless it is owned by this
/// process's uid and not group/other-writable. The row now lives in a
/// shared multi-namespace store written by many rt code paths, rather than
/// a single-purpose file, so this keeps "the shim can only ever run what
/// this user configured" an enforced property rather than an assumption.
func isTrustedStateDb(_ path: String) -> Bool {
    var st = stat()
    guard stat(path, &st) == 0 else { return false }
    guard st.st_uid == getuid() else { return false }
    let writableByGroupOrOther = mode_t(S_IWGRP) | mode_t(S_IWOTH)
    return (st.st_mode & writableByGroupOrOther) == 0
}

private func sqliteErrorMessage(_ db: OpaquePointer?) -> String {
    guard let db, let cMsg = sqlite3_errmsg(db) else { return "unknown error" }
    return String(cString: cMsg)
}

/// Reads the ns='dev-mode', k='config' row out of `kv` in `dbPath`.
///
/// Returns `(config, "")` on success, `(nil, detail)` on any failure —
/// `detail` is always populated (file missing, untrusted ownership/mode,
/// open/prepare/step sqlite errors via `sqlite3_errmsg`, no row, or a row
/// whose JSON doesn't validate) so the caller's `standDown` can say
/// specifically why, distinguishing "never configured" from a transient
/// read failure. `busy_timeout` is set before any query so a concurrent CLI
/// writer (`rt settings dev-mode on`, which opens the same db to
/// migrate/write) cannot wedge daemon boot — this shim waits, briefly,
/// rather than either blocking forever or failing hard on the first
/// SQLITE_BUSY.
func readDevModeConfigFromStateDb(dbPath: String, home: String) -> (DevModeConfig?, String) {
    guard FileManager.default.fileExists(atPath: dbPath) else {
        return (nil, "no state.db at \(dbPath)")
    }
    guard isTrustedStateDb(dbPath) else {
        return (nil, "state.db at \(dbPath) is not owned by this user or is group/other-writable — refusing to trust it")
    }

    var db: OpaquePointer?
    // Read-only: this shim only ever reads state.db, never migrates or
    // creates it — that stays the CLI/daemon's job (lib/state/db.ts).
    let openResult = sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil)
    guard openResult == SQLITE_OK, let db else {
        let msg = sqliteErrorMessage(db)
        sqlite3_close(db)
        return (nil, "could not open \(dbPath): \(msg)")
    }
    defer { sqlite3_close(db) }

    sqlite3_busy_timeout(db, 5000)

    var stmt: OpaquePointer?
    let sql = "SELECT v FROM kv WHERE ns = ? AND k = ?;"
    let prepareResult = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
    guard prepareResult == SQLITE_OK, let stmt else {
        // Most commonly "no such table: kv" on a pre-migration db.
        let msg = sqliteErrorMessage(db)
        sqlite3_finalize(stmt)
        return (nil, "could not query \(dbPath): \(msg)")
    }
    defer { sqlite3_finalize(stmt) }

    sqlite3_bind_text(stmt, 1, "dev-mode", -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(stmt, 2, "config", -1, SQLITE_TRANSIENT)

    let stepResult = sqlite3_step(stmt)
    guard stepResult == SQLITE_ROW else {
        if stepResult == SQLITE_DONE {
            return (nil, "no dev-mode row in \(dbPath)") // a fresh machine, or dev mode never enabled
        }
        return (nil, "could not read dev-mode row from \(dbPath): \(sqliteErrorMessage(db)) (sqlite code \(stepResult))")
    }
    guard let cText = sqlite3_column_text(stmt, 0) else {
        return (nil, "dev-mode row in \(dbPath) has a NULL value")
    }

    let json = String(cString: cText)
    guard
        let data = json.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return (nil, "dev-mode row in \(dbPath) is not valid JSON")
    }

    guard let config = finalizeConfig(sourcePathRaw: parsed["sourcePath"] as? String, bunPathRaw: parsed["bunPath"] as? String, home: home) else {
        return (nil, "dev-mode row in \(dbPath) has no absolute sourcePath")
    }
    return (config, "")
}

/// See the LEGACY FALLBACK note at the top of this file. Read-only, exactly
/// like the state.db path — never writes, never renames; migrating the file
/// out of the way stays commands/settings.ts's job.
func readDevModeConfigFromLegacyFile(path: String, home: String) -> (DevModeConfig?, String) {
    guard let raw = FileManager.default.contents(atPath: path) else {
        return (nil, "no legacy config at \(path)")
    }
    guard let parsed = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] else {
        return (nil, "legacy config at \(path) is not valid JSON")
    }
    guard let config = finalizeConfig(sourcePathRaw: parsed["sourcePath"] as? String, bunPathRaw: parsed["bunPath"] as? String, home: home) else {
        return (nil, "legacy config at \(path) has no absolute sourcePath")
    }
    return (config, "")
}

guard let home = ProcessInfo.processInfo.environment["HOME"] else {
    standDown("HOME not set")
}

// Redirect fd 2 to ~/.mattstack/rt/logs/daemon-stderr.log so bun's native
// panics (segfaults, ASan output, runtime asserts) land in a file instead of
// /dev/null, AND so every stand-down message below is captured too — moved
// above every precondition check (was after) because the LaunchAgent plist
// omits StandardErrorPath: under launchd, anything logged before this point
// is unrecoverable, and anything after it is the only diagnostic a stuck
// daemon leaves behind. pino captures JS-side stderr separately once bun is
// running — this only catches what bypasses JS, plus this shim's own
// messages, which is everything that runs before bun exists.
let logsDir = "\(home)/.mattstack/rt/logs"
try? FileManager.default.createDirectory(
    atPath: logsDir,
    withIntermediateDirectories: true
)
// "a" (append) — preserve prior crash output until the user clears it.
// freopen returns NULL on failure; we ignore failure so a permissions issue
// doesn't blackhole the daemon — stderr stays pointed at its inherited fd.
_ = freopen("\(logsDir)/daemon-stderr.log", "a", stderr)

let dbPath = "\(home)/.mattstack/rt/state.db"
let (dbConfig, dbDetail) = readDevModeConfigFromStateDb(dbPath: dbPath, home: home)

let config: DevModeConfig
if let dbConfig {
    config = dbConfig
} else {
    let legacyPath = "\(home)/.mattstack/rt/dev-mode.json"
    let (legacyConfig, legacyDetail) = readDevModeConfigFromLegacyFile(legacyPath, home: home)
    guard let legacyConfig else {
        standDown("no dev-mode config — state.db: \(dbDetail); legacy file: \(legacyDetail)")
    }
    config = legacyConfig
}

let sourcePath = config.sourcePath
let bunPath = config.bunPath
let daemonEntry = "\(sourcePath)/lib/daemon.ts"

guard FileManager.default.fileExists(atPath: bunPath) else {
    standDown("bun not found at \(bunPath)")
}
guard FileManager.default.fileExists(atPath: daemonEntry) else {
    standDown("daemon source not found at \(daemonEntry)")
}

// Forward any args launchd passes (e.g. "--daemon")
let forwarded = Array(CommandLine.arguments.dropFirst())
let execArgs = ["bun", "run", daemonEntry] + forwarded

var cArgs: [UnsafeMutablePointer<CChar>?] = execArgs.map { strdup($0) }
cArgs.append(nil)

execv(bunPath, &cArgs)
// Only reached on failure. Every precondition passed and bun still refused to
// exec — the genuine-failure branch of the contract, not a stand-down.
fail("execv(\(bunPath)) failed: \(String(cString: strerror(errno)))")
