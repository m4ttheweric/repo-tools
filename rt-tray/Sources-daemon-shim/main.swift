// rt-daemon-shim
//
// Tiny signed exec-proxy that lets the daemon run from source under launchd
// supervision. Launched by SMAppService in place of the compiled rt-daemon
// binary; execs into `bun run <sourcePath>/lib/daemon.ts` so edits take effect
// on the next daemon restart without a release cycle.
//
// Configuration comes from ~/.rt/dev-mode.json:
//   { "sourcePath": "/path/to/repo-tools", "bunPath": "/Users/.../.bun/bin/bun" }
//
// Signed with the rt-tray Developer ID so launchd's LWCR check accepts it.
// TCC inherits from rt-tray.app because the shim lives inside the bundle.

import Foundation

@inline(__always)
func die(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("rt-daemon-shim: \(msg)\n".utf8))
    exit(78) // EX_CONFIG
}

guard let home = ProcessInfo.processInfo.environment["HOME"] else {
    die("HOME not set")
}

let configPath = "\(home)/.rt/dev-mode.json"
guard let raw = FileManager.default.contents(atPath: configPath) else {
    die("config not found: \(configPath)")
}

guard
    let parsed = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
    let sourcePath = parsed["sourcePath"] as? String
else {
    die("config missing sourcePath")
}

let bunPath = (parsed["bunPath"] as? String) ?? "\(home)/.bun/bin/bun"
let daemonEntry = "\(sourcePath)/lib/daemon.ts"

guard FileManager.default.fileExists(atPath: bunPath) else {
    die("bun not found at \(bunPath)")
}
guard FileManager.default.fileExists(atPath: daemonEntry) else {
    die("daemon source not found at \(daemonEntry)")
}

// Forward any args launchd passes (e.g. "--daemon")
let forwarded = Array(CommandLine.arguments.dropFirst())
let execArgs = ["bun", "run", daemonEntry] + forwarded

var cArgs: [UnsafeMutablePointer<CChar>?] = execArgs.map { strdup($0) }
cArgs.append(nil)

execv(bunPath, &cArgs)
// Only reached on failure
die("execv(\(bunPath)) failed: \(String(cString: strerror(errno)))")
