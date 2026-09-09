import Foundation

/// What the CA trust write did. It reaches the app on its own stdout line
/// (`MATTSTACK_TRUST=<rawValue>`) because the install proceeds either way: an
/// untrusted proxy still serves, and the checklist row carries the remedy.
enum TrustOutcome: String {
    case ok, declined, failed
}

// macOS gates `com.apple.trust-settings.admin` behind `entitled OR
// authenticate-admin`, and `authenticate-admin` carries `timeout 0`: root is
// not enough, no Developer ID process can be entitled, and the credential the
// escalation prompt collected is never reused. So this write always raises its
// own dialog, and the user can refuse it without refusing the install.
struct TrustStep {
    let caPath: String
    let fs: FileOps
    let runner: CommandRunner
    /// Long enough to read a dialog and type a password, bounded because an
    /// unanswered prompt would otherwise hold the whole Install open.
    var promptTimeout: TimeInterval = 120

    struct Outcome {
        let state: TrustOutcome
        let line: String
    }

    static func addArgv(_ caPath: String) -> [String] {
        ["/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot",
         "-k", "/Library/Keychains/System.keychain", caPath]
    }

    /// Parity anchor: isCATrustedMacOS in portless's own dist/cli.js. The
    /// helper, the tool.proxy row and portless itself must answer "is this CA
    /// trusted" the same way, or they disagree about a machine none of them
    /// changed. `-L` keeps it local: no network fetch, so it is deterministic.
    static func verifyArgv(_ caPath: String) -> [String] {
        ["/usr/bin/security", "verify-cert", "-c", caPath, "-L", "-p", "ssl"]
    }

    func run() -> Outcome {
        guard (try? fs.stat(URL(fileURLWithPath: caPath))) != nil else {
            return Outcome(state: .failed, line: "trust: failed no CA certificate at \(caPath)")
        }
        // Re-writing settings that are already there would raise the dialog on
        // every re-install and every version bump, for nothing.
        if runCommand(Self.verifyArgv(caPath), timeout: 30).status == 0 {
            return Outcome(state: .ok, line: "trust: ok (already trusted)")
        }
        let add = runCommand(Self.addArgv(caPath), timeout: promptTimeout)
        if add.status == 0 { return Outcome(state: .ok, line: "trust: ok") }
        let detail = Self.condensed(add.output.isEmpty ? "security exited \(add.status)" : add.output)
        return Self.isDeclined(add.output)
            ? Outcome(state: .declined, line: "trust: declined \(detail)")
            : Outcome(state: .failed, line: "trust: failed \(detail)")
    }

    /// A refusal at the dialog comes back as errAuthorizationCanceled (-60006)
    /// or errSecUserCanceled (-128), whose messages spell the word either way
    /// round. "The authorization was denied since no user interaction was
    /// possible" is deliberately not a decline: nobody was asked.
    static func isDeclined(_ output: String) -> Bool {
        let lowered = output.lowercased()
        return lowered.contains("cancel") || lowered.contains("-60006") || lowered.contains("-128")
    }

    static func condensed(_ output: String) -> String {
        let flattened = output
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
        return flattened.count > 400 ? String(flattened.prefix(400)) + "…" : flattened
    }

    private func runCommand(_ argv: [String], timeout: TimeInterval) -> CommandResult {
        do {
            return try runner.run(argv, env: ["PATH": LaunchdPlist.daemonPath], timeout: timeout)
        } catch {
            return CommandResult(status: -1, output: "\(error)")
        }
    }
}

/// Records WHICH certificate was trusted, root-owned beside VERSION, so that
/// `remove` can name the System-keychain entry without reading anything the
/// console user can write. Only a trusted CA is recorded: with no record,
/// `remove` untrusts nothing, which is the correct answer for a machine where
/// the trust write never landed.
enum TrustRecord {
    /// nil when the record is written; a reportable line when it is not. A
    /// failure here costs the uninstall its untrust step and nothing else, so
    /// it never changes the trust outcome.
    static func write(caPath: String, to destination: String, fs: FileOps) -> String? {
        let target = URL(fileURLWithPath: destination)
        do {
            // copyItem refuses an existing destination, and re-trusting an
            // already-installed machine reaches here with the last record in
            // place.
            try fs.removeTree(target)
            try fs.copyItem(from: URL(fileURLWithPath: caPath), to: target)
            try fs.setOwner(target, uid: 0, gid: 0)
            try fs.setMode(target, InstalledMode.file)
            return nil
        } catch {
            return "trust record: failed \(error); uninstall will leave the certificate trusted"
        }
    }
}

/// The `trust` verb: the Retry behind the untrusted-certificate row. It runs
/// the same write install step 3 runs and nothing else, so a machine that
/// declined once can say yes later without reinstalling anything.
struct TrustOp {
    let caPath: String
    let fs: FileOps
    let runner: CommandRunner
    var emit: (String) -> Void = Report.step
    var trustedCaPath: String = ProxyPaths.trustedCa

    static func run() -> Int32 {
        guard geteuid() == 0 else {
            Report.step("mattstack-proxy-install trust must run as root")
            return ExitCode.noPerm
        }
        let user: ConsoleUser
        do { user = try ConsoleUser.current() } catch {
            Report.step("\(error)")
            return ExitCode.config
        }
        return TrustOp(caPath: user.caPath, fs: RealFileOps(), runner: RealCommandRunner()).execute()
    }

    func execute() -> Int32 {
        let outcome = TrustStep(caPath: caPath, fs: fs, runner: runner).run()
        if outcome.state == .ok, let problem = TrustRecord.write(caPath: caPath, to: trustedCaPath, fs: fs) {
            emit(problem)
        }
        emit(outcome.line)
        emit(Report.trustLine(outcome.state))
        // Declining is an answer, not a fault: the row keeps the remedy and the
        // proxy keeps serving, so only a CA we could not find or a call that
        // broke on its own terms is a failed run.
        return outcome.state == .failed ? ExitCode.osErr : ExitCode.ok
    }
}
