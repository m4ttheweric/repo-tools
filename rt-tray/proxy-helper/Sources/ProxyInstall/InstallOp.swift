import Foundation

// The root-owned home of everything the LaunchDaemon execs. No path here comes
// from argv: the escalator hands this helper a bundle, not a destination.
enum ProxyPaths {
    static let root = "/Library/Application Support/mattstack/proxy"
    static let node = root + "/node"
    static let cli = root + "/portless-dist/dist/cli.js"
    static let logDir = root + "/log"
    static let logFile = logDir + "/service.log"
}

struct InstallOp {
    let bundleRoot: URL
    let user: ConsoleUser
    let pins: PinsValues
    let fs: FileOps
    let runner: CommandRunner
    var copyPayload: (URL, URL, FileOps, PinsValues) throws -> Void = CopyStep.run

    static func run() -> Int32 {
        // Everything below assumes root; refusing here keeps an unescalated run
        // from reporting a filesystem permission error as if it were a defect.
        guard geteuid() == 0 else {
            Report.step("mattstack-proxy-install install must run as root")
            return ExitCode.noPerm
        }
        let user: ConsoleUser
        do { user = try ConsoleUser.current() } catch {
            Report.step("\(error)")
            return ExitCode.config
        }
        guard let executable = ownExecutable() else {
            Report.step("cannot resolve the helper's own path")
            return ExitCode.software
        }
        return InstallOp(
            bundleRoot: bundleRoot(forExecutable: executable),
            user: user,
            pins: Pins.current,
            fs: RealFileOps(),
            runner: RealCommandRunner()
        ).execute()
    }

    /// The helper lives at `Contents/Helpers/<name>` and CopyStep reads
    /// `Helpers/…` off the root it is handed, so the root is `Contents`.
    static func bundleRoot(forExecutable executable: URL) -> URL {
        executable.deletingLastPathComponent().deletingLastPathComponent()
    }

    static func ownExecutable() -> URL? {
        var size = UInt32(PATH_MAX)
        var buffer = [CChar](repeating: 0, count: Int(size) + 1)
        guard _NSGetExecutablePath(&buffer, &size) == 0, let real = realpath(buffer, nil) else { return nil }
        defer { free(real) }
        return URL(fileURLWithPath: String(cString: real))
    }

    func execute() -> Int32 {
        do {
            try copyPayload(bundleRoot, URL(fileURLWithPath: ProxyPaths.root), fs, pins)
        } catch {
            Report.step("copy failed: \(error)")
            return ExitCode.software
        }
        Report.step("copy: ok")

        let plist = URL(fileURLWithPath: LaunchdPlist.path)
        let plistStage = URL(fileURLWithPath: LaunchdPlist.stagePath)
        var plistPreexisted = false
        do {
            plistPreexisted = try fs.stat(plist) != nil
            // launchd creates the log FILE but not its directory, and CopyStep's
            // rename replaces the whole tree, so this runs after the copy.
            try fs.mkdir(URL(fileURLWithPath: ProxyPaths.logDir))
            try fs.write(
                LaunchdPlist.render(
                    nodePath: ProxyPaths.node,
                    cliPath: ProxyPaths.cli,
                    stateDir: user.stateDir,
                    user: user,
                    logPath: ProxyPaths.logFile),
                to: plistStage)
            try fs.setMode(plistStage, 0o644)
            try fs.setOwner(plistStage, uid: 0, gid: 0)
            try fs.rename(from: plistStage, to: plist)
        } catch {
            Report.step("plist failed: \(error)")
            discard(plistStage)
            return ExitCode.software
        }
        Report.step("plist: ok")

        let trust = runCommand([ProxyPaths.node, ProxyPaths.cli, "trust"], env: portlessEnvironment)
        guard trust.status == 0 else {
            Report.step("trust failed (\(trust.status)): \(condensed(trust.output))")
            rollbackPlist(preexisted: plistPreexisted)
            return ExitCode.osErr
        }
        Report.step("trust: ok")

        let sudoersStage = URL(fileURLWithPath: Sudoers.stagePath)
        // One cleanup path for the whole step: a candidate rule that is not
        // going to be installed must never outlive the run that wrote it.
        var sudoersFailure = ExitCode.software
        do {
            try fs.write(Sudoers.render(user: user.name), to: sudoersStage)
            try fs.setMode(sudoersStage, 0o440)
            try fs.setOwner(sudoersStage, uid: 0, gid: 0)
            let check = runCommand(["/usr/sbin/visudo", "-c", "-f", Sudoers.stagePath])
            guard check.status == 0 else {
                sudoersFailure = ExitCode.dataErr
                throw ProxyInstallError("rejected by visudo (\(check.status)): \(condensed(check.output))")
            }
            try fs.rename(from: sudoersStage, to: URL(fileURLWithPath: Sudoers.path))
        } catch {
            Report.step("sudoers failed: \(error)")
            discard(sudoersStage)
            rollbackPlist(preexisted: plistPreexisted)
            return sudoersFailure
        }
        Report.step("sudoers: ok")

        // A first install has no service to tear down, so bootout's failure is
        // the normal case; re-install is the update path, and there it matters.
        _ = runCommand(["/bin/launchctl", "bootout", "system/" + LaunchdPlist.label])
        let bootstrap = runCommand(["/bin/launchctl", "bootstrap", "system", LaunchdPlist.path])
        guard bootstrap.status == 0 else {
            Report.step("bootstrap failed (\(bootstrap.status)): \(condensed(bootstrap.output))")
            rollbackPlist(preexisted: plistPreexisted)
            return ExitCode.osErr
        }
        Report.step("bootstrap: ok")
        return ExitCode.ok
    }

    /// The trust run and the daemon share an environment, so the CA the one
    /// installs lands in the state dir the other reads, owned by the user.
    private var portlessEnvironment: [String: String] {
        [
            "PORTLESS_STATE_DIR": user.stateDir,
            "HOME": user.home,
            "SUDO_UID": String(user.uid),
            "SUDO_GID": String(user.gid),
            "PATH": LaunchdPlist.daemonPath,
        ]
    }

    /// Children get a stated environment, never this process's: what the
    /// escalator handed down is not something a root subprocess should inherit.
    private func runCommand(
        _ argv: [String],
        env: [String: String] = ["PATH": LaunchdPlist.daemonPath]
    ) -> CommandResult {
        do { return try runner.run(argv, env: env) } catch {
            return CommandResult(status: -1, output: "\(error)")
        }
    }

    /// lib/setup/steps/services.ts reads the plist's mere presence as "already
    /// installed" and skips, so a plist this run wrote and then failed behind
    /// would make every later Install report done over a proxy that was never
    /// bootstrapped. One that was already there is the previous, working install
    /// and outlives a failed upgrade.
    private func rollbackPlist(preexisted: Bool) {
        guard !preexisted else { return }
        discard(URL(fileURLWithPath: LaunchdPlist.path))
    }

    private func discard(_ path: URL) {
        do { try fs.removeTree(path) } catch {
            Report.step("could not remove \(path.path): \(error)")
        }
    }

    private func condensed(_ output: String) -> String {
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > 2000 ? String(trimmed.prefix(2000)) + "…" : trimmed
    }
}
