import Foundation

// Every step here is a deletion of state InstallOp itself wrote, so absence
// is success at every point: a second remove, or a remove with no prior
// install, must return 0. Only a deletion that fails for a real reason
// (permission denied, I/O error) is unexpected and stops the run.
struct RemoveOp {
    /// The console user's `~/.portless`, resolved once by `run()`. `nil`
    /// when no one is logged in at the console (or the query failed), which
    /// only affects the CA lookup below: nothing else here needs a user.
    let stateDir: String?
    let fs: FileOps
    let runner: CommandRunner

    static func run() -> Int32 {
        RemoveOp(stateDir: try? ConsoleUser.current().stateDir, fs: RealFileOps(), runner: RealCommandRunner()).execute()
    }

    func execute() -> Int32 {
        // A first remove (or a remove after one already ran) has no service
        // to stop, so bootout's failure is the normal case, same as install's.
        _ = runCommand(["/bin/launchctl", "bootout", "system/" + LaunchdPlist.label])
        Report.step("bootout: ok")

        guard remove(LaunchdPlist.path, name: "plist") else { return ExitCode.software }
        guard remove(Sudoers.path, name: "sudoers") else { return ExitCode.software }

        untrustCA()

        guard remove(ProxyPaths.root, name: "proxy root") else { return ExitCode.software }

        return ExitCode.ok
    }

    private func remove(_ path: String, name: String) -> Bool {
        do {
            try fs.removeTree(URL(fileURLWithPath: path))
        } catch {
            Report.step("\(name) removal failed: \(error)")
            return false
        }
        Report.step("\(name): removed")
        return true
    }

    /// The CA is a convenience registered with the OS trust store, not state
    /// this op is the sole owner of, so nothing in here can fail the run:
    /// every branch that gives up logs why and returns.
    private func untrustCA() {
        guard let stateDir else {
            Report.step("untrust: no console user, skipping")
            return
        }
        let caPath = URL(fileURLWithPath: stateDir).appendingPathComponent("ca.pem")
        guard (try? fs.stat(caPath)) != nil else {
            Report.step("untrust: no CA at \(caPath.path), skipping")
            return
        }

        let subject = runCommand(["/usr/bin/openssl", "x509", "-noout", "-subject", "-in", caPath.path])
        guard subject.status == 0, let commonName = Self.commonName(fromSubjectLine: subject.output) else {
            Report.step("untrust: could not read a common name from \(caPath.path), skipping")
            return
        }

        // security delete-certificate returns the same nonzero status for
        // "already gone" as for anything else, so its result cannot
        // distinguish idempotency from a real failure; treat both as
        // non-fatal, consistent with every other step in this op.
        let delete = runCommand(["/usr/bin/security", "delete-certificate", "-c", commonName, "/Library/Keychains/System.keychain"])
        Report.step(delete.status == 0 ? "untrust: ok" : "untrust: certificate not present, skipping")
    }

    /// portless generates its CA with a subject of exactly `/CN=<name>`, so
    /// openssl's `-subject` line (`subject=CN=<name>`) has no further RDNs
    /// to strip past the marker.
    static func commonName(fromSubjectLine line: String) -> String? {
        guard let range = line.range(of: "CN=") else { return nil }
        let name = line[range.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// Children get a stated environment, never this process's, same as
    /// InstallOp's subprocesses.
    private func runCommand(_ argv: [String], env: [String: String] = ["PATH": LaunchdPlist.daemonPath]) -> CommandResult {
        do { return try runner.run(argv, env: env) } catch {
            return CommandResult(status: -1, output: "\(error)")
        }
    }
}
