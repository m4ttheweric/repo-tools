// rt-daemon-shim
//
// Tiny signed exec-proxy that lets the daemon run from source under launchd
// supervision. This binary IS the dev bundle's Contents/MacOS/rt-daemon
// (spec MAT-383 §3) — permanently the dev flavor's daemon launcher, never a
// swap payload dropped into the prod bundle. It execs
// `bun run <sourcePath>/lib/daemon.ts` so edits take effect on the next
// daemon restart without a release cycle.
//
// Configuration comes from ~/.mattstack/rt/dev-mode.json:
//   { "sourcePath": "/path/to/repo-tools", "bunPath": "/Users/.../.bun/bin/bun" }
//
// EXIT-CODE CONTRACT (spec MAT-383 §3) — the dev agent plist sets
// KeepAlive = { SuccessfulExit = false }, which makes the exit code the only
// signal launchd has:
//
//   exit 0  — a precondition isn't met (no dev-mode config, source tree moved,
//             bun not installed). Nothing is wrong with the machine; the dev
//             flavor simply has nothing to run. launchd leaves it down, and
//             one log line says why. NOT an error, NOT a crash loop.
//   exit >0 — something genuinely unexpected failed after every precondition
//             checked out (execv into an existing bun refused). launchd
//             restarts, which is the right response to a real crash.
//
// Signed with the same Developer ID as the rest of the dev bundle, keeping the
// `-i rt-daemon` identifier override so launchd's LWCR check accepts it.
// TCC inherits from the app bundle because the shim lives inside it.

import Foundation

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

guard let home = ProcessInfo.processInfo.environment["HOME"] else {
    standDown("HOME not set")
}

let configPath = "\(home)/.mattstack/rt/dev-mode.json"
guard let raw = FileManager.default.contents(atPath: configPath) else {
    standDown("no dev-mode config at \(configPath)")
}

guard
    let parsed = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
    let sourcePath = parsed["sourcePath"] as? String
else {
    standDown("dev-mode config has no sourcePath: \(configPath)")
}

let bunPath = (parsed["bunPath"] as? String) ?? "\(home)/.bun/bin/bun"
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
