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
// EXIT-CODE CONTRACT (spec MAT-383 §3) — the dev agent plist sets
// KeepAlive = { SuccessfulExit = false }, which makes the exit code the only
// signal launchd has:
//
//   exit 0  — a precondition isn't met (no dev-mode config, source tree moved,
//             bun not installed). Nothing is wrong with the machine; the dev
//             flavor simply has nothing to run. launchd leaves it down, and
//             one log line says why. NOT an error, NOT a crash loop. A
//             missing state.db, a missing `kv` table, and a missing/corrupt
//             row all fold into this same path — none of them is more
//             "wrong" than a fresh machine with no dev-mode.json ever was.
//   exit >0 — something genuinely unexpected failed after every precondition
//             checked out (execv into an existing bun refused). launchd
//             restarts, which is the right response to a real crash.
//
// Signed with the same Developer ID as the rest of the dev bundle, keeping the
// `-i rt` identifier override so launchd's LWCR check accepts it.
// TCC inherits from the app bundle because the shim lives inside it.

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

/// Reads the ns='dev-mode', k='config' row out of `kv` in `dbPath`.
///
/// Every failure mode — the file doesn't exist, it isn't a database, the
/// `kv` table doesn't exist yet (a state.db older than this migration, or
/// none at all), the row doesn't exist, or the row's JSON has no
/// `sourcePath` — returns `nil` and is handled identically by the caller's
/// `standDown`, matching the missing-dev-mode.json contract this replaces.
/// `busy_timeout` is set before any query so a concurrent CLI writer
/// (`rt settings dev-mode on`, which opens the same db to migrate/write)
/// cannot wedge daemon boot — this shim waits, briefly, rather than either
/// blocking forever or failing hard on the first SQLITE_BUSY.
func readDevModeConfig(dbPath: String, home: String) -> DevModeConfig? {
    guard FileManager.default.fileExists(atPath: dbPath) else { return nil }

    var db: OpaquePointer?
    // Read-only: this shim only ever reads state.db, never migrates or
    // creates it — that stays the CLI/daemon's job (lib/state/db.ts).
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
        sqlite3_close(db)
        return nil
    }
    defer { sqlite3_close(db) }

    sqlite3_busy_timeout(db, 5000)

    var stmt: OpaquePointer?
    let sql = "SELECT v FROM kv WHERE ns = ? AND k = ?;"
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
        // Most commonly "no such table: kv" on a pre-migration db.
        sqlite3_finalize(stmt)
        return nil
    }
    defer { sqlite3_finalize(stmt) }

    sqlite3_bind_text(stmt, 1, "dev-mode", -1, SQLITE_TRANSIENT)
    sqlite3_bind_text(stmt, 2, "config", -1, SQLITE_TRANSIENT)

    guard sqlite3_step(stmt) == SQLITE_ROW, let cText = sqlite3_column_text(stmt, 0) else {
        return nil // no row for this key — a fresh machine, or dev mode never enabled
    }

    let json = String(cString: cText)
    guard
        let data = json.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let sourcePath = parsed["sourcePath"] as? String
    else {
        return nil
    }

    let bunPath = (parsed["bunPath"] as? String) ?? "\(home)/.bun/bin/bun"
    return DevModeConfig(sourcePath: sourcePath, bunPath: bunPath)
}

guard let home = ProcessInfo.processInfo.environment["HOME"] else {
    standDown("HOME not set")
}

let dbPath = "\(home)/.mattstack/rt/state.db"
guard let config = readDevModeConfig(dbPath: dbPath, home: home) else {
    standDown("no dev-mode config in \(dbPath)")
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

// Redirect fd 2 to ~/.mattstack/rt/logs/daemon-stderr.log so bun's native panics
// (segfaults, ASan output, runtime asserts) land in a file instead of /dev/null.
// pino captures JS-side stderr separately — this only catches what bypasses JS.
// The shim runs BEFORE bun, so it's the only place we can dup fd 2 before any
// code that might crash.
let logsDir = "\(home)/.mattstack/rt/logs"
try? FileManager.default.createDirectory(
    atPath: logsDir,
    withIntermediateDirectories: true
)
// "a" (append) — preserve prior crash output until the user clears it.
// freopen returns NULL on failure; we ignore failure so a permissions issue
// doesn't blackhole the daemon — stderr stays pointed at its inherited fd.
_ = freopen("\(logsDir)/daemon-stderr.log", "a", stderr)

// Forward any args launchd passes (e.g. "--daemon")
let forwarded = Array(CommandLine.arguments.dropFirst())
let execArgs = ["bun", "run", daemonEntry] + forwarded

var cArgs: [UnsafeMutablePointer<CChar>?] = execArgs.map { strdup($0) }
cArgs.append(nil)

execv(bunPath, &cArgs)
// Only reached on failure. Every precondition passed and bun still refused to
// exec — the genuine-failure branch of the contract, not a stand-down.
fail("execv(\(bunPath)) failed: \(String(cString: strerror(errno)))")
