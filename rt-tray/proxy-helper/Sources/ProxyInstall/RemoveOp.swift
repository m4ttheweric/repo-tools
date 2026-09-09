import Foundation

// Every step here is a deletion of state InstallOp itself wrote, so absence
// is success at every point: a second remove, or a remove with no prior
// install, must return 0. Only a deletion that fails for a real reason
// (permission denied, I/O error) is unexpected and stops the run.
struct RemoveOp {
    let fs: FileOps
    let runner: CommandRunner
    /// The certificate the install recorded as the one it trusted. Nothing
    /// here reads the console user's `~/.portless`: this op runs as root and
    /// deletes from the System keychain by what it finds.
    var trustedCaPath: String = ProxyPaths.trustedCa

    static func run() -> Int32 {
        // Same refusal install and trust make: unescalated, every deletion
        // below still runs for real against launchd and the System keychain,
        // and the EPERM that follows reports as this helper's own failure.
        guard geteuid() == 0 else {
            Report.step("mattstack-proxy-install remove must run as root")
            return ExitCode.noPerm
        }
        return RemoveOp(fs: RealFileOps(), runner: RealCommandRunner()).execute()
    }

    func execute() -> Int32 {
        // A first remove (or a remove after one already ran) has no service
        // to stop, so bootout's failure is the normal case, same as install's.
        // The status is reported rather than assumed: a nonzero exit here
        // means "nothing to stop" as often as it means a real launchd error,
        // and this op can't tell those apart any better than the CA step can.
        let bootout = runCommand(["/bin/launchctl", "bootout", "system/" + LaunchdPlist.label])
        Report.step(Self.bootoutMessage(status: bootout.status))

        guard remove(LaunchdPlist.path, name: "plist") else { return ExitCode.software }
        guard remove(Sudoers.path, name: "sudoers") else { return ExitCode.software }

        // Before the root tree goes: the certificate this reads to identify the
        // keychain entry lives inside it.
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
        let caPath = URL(fileURLWithPath: trustedCaPath)
        // No record means no trust write ever landed here, so there is nothing
        // this op put in the keychain to take back out.
        guard (try? fs.stat(caPath)) != nil else {
            Report.step("untrust: no trusted CA recorded at \(caPath.path), skipping")
            return
        }

        let fingerprint = runCommand(["/usr/bin/openssl", "x509", "-noout", "-fingerprint", "-sha1", "-in", caPath.path])
        guard fingerprint.status == 0, let hash = Self.sha1(fromFingerprintLine: fingerprint.output) else {
            Report.step("untrust: could not read a fingerprint from \(caPath.path), skipping")
            return
        }

        // security delete-certificate returns the same nonzero status for
        // "already gone" as for anything else, so its result cannot
        // distinguish idempotency from a real failure; treat both as
        // non-fatal, consistent with every other step in this op, but log
        // the status rather than asserting which one it was.
        let delete = runCommand(["/usr/bin/security", "delete-certificate", "-Z", hash, "/Library/Keychains/System.keychain"])
        Report.step(Self.untrustMessage(deleteStatus: delete.status))
    }

    static func bootoutMessage(status: Int32) -> String {
        status == 0 ? "bootout: ok" : "bootout: status \(status), ignoring"
    }

    static func untrustMessage(deleteStatus: Int32) -> String {
        deleteStatus == 0
            ? "untrust: ok"
            : "untrust: delete-certificate failed (status \(deleteStatus)), skipping"
    }

    /// openssl prints `SHA1 Fingerprint=AB:CD:...`; `delete-certificate -Z`
    /// wants that hex with the colons gone. The fingerprint is what names ONE
    /// certificate: a common name does not, and another System-keychain entry
    /// carrying the same one would be what this root deletion hit.
    static func sha1(fromFingerprintLine line: String) -> String? {
        guard let marker = line.range(of: "=") else { return nil }
        let hex = line[marker.upperBound...]
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: ":", with: "")
        guard hex.count == 40, hex.allSatisfy(\.isHexDigit) else { return nil }
        return hex.uppercased()
    }

    /// Children get a stated environment, never this process's, same as
    /// InstallOp's subprocesses.
    private func runCommand(_ argv: [String], env: [String: String] = ["PATH": LaunchdPlist.daemonPath]) -> CommandResult {
        do { return try runner.run(argv, env: env) } catch {
            return CommandResult(status: -1, output: "\(error)")
        }
    }
}
