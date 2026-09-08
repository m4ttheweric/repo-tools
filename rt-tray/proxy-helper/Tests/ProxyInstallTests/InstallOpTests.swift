import Foundation
import XCTest
@testable import ProxyInstall

// InstallOp's own subject is the ORDER of the sub-steps and what each failure
// leaves behind; the steps themselves are proven elsewhere (CopyStep by its own
// suite, the two renderers by their goldens, the privileged commands by the VM
// leg). So both seams are fakes here and nothing touches the disk.
final class RecordingFileOps: FileOps {
    /// Files that already exist. Seed it to model a re-install or upgrade.
    var existingPaths: Set<String> = []
    var failWritesTo: Set<String> = []
    var failRemovesOf: Set<String> = []

    /// Every mutating call, in order, as "<op> <path>". Lets a test assert that
    /// a stage was chmod/chown'd BEFORE it was renamed into place.
    private(set) var ops: [String] = []
    private(set) var written: [String: String] = [:]
    private(set) var renames: [(from: String, to: String)] = []
    private(set) var replaced: [(from: String, to: String)] = []
    private(set) var removed: [String] = []
    private(set) var made: [String] = []
    private(set) var modes: [String: mode_t] = [:]
    private(set) var owners: [String: String] = [:]

    func list(_ root: URL) throws -> [String] { [] }
    func read(_ path: URL) throws -> Data { Data() }

    func stat(_ path: URL) throws -> PathStat? {
        existingPaths.contains(path.path) ? PathStat(uid: 0, isRegularFile: true) : nil
    }

    func mkdir(_ path: URL) throws { made.append(path.path); ops.append("mkdir \(path.path)") }
    func copyItem(from: URL, to: URL) throws {}

    func write(_ contents: String, to path: URL) throws {
        if failWritesTo.contains(path.path) { throw ProxyInstallError("write refused: \(path.path)") }
        written[path.path] = contents
        existingPaths.insert(path.path)
        ops.append("write \(path.path)")
    }

    // Non-clobber, matching FileManager.moveItem: throws when the destination
    // exists. InstallOp must never reach for this on a live install path.
    func rename(from: URL, to: URL) throws {
        if existingPaths.contains(to.path) {
            throw ProxyInstallError("moveItem: \(to.path) already exists")
        }
        existingPaths.remove(from.path)
        existingPaths.insert(to.path)
        renames.append((from: from.path, to: to.path))
        ops.append("rename \(to.path)")
    }

    func replaceFile(from: URL, to: URL) throws {
        existingPaths.remove(from.path)
        existingPaths.insert(to.path)
        replaced.append((from: from.path, to: to.path))
        ops.append("replace \(to.path)")
    }

    func removeTree(_ path: URL) throws {
        if failRemovesOf.contains(path.path) { throw ProxyInstallError("remove refused: \(path.path)") }
        existingPaths.remove(path.path)
        removed.append(path.path)
        ops.append("remove \(path.path)")
    }

    func setMode(_ path: URL, _ mode: mode_t) throws { modes[path.path] = mode; ops.append("chmod \(path.path)") }
    func setOwner(_ path: URL, uid: uid_t, gid: gid_t) throws { owners[path.path] = "\(uid):\(gid)"; ops.append("chown \(path.path)") }
}

final class FakeCommandRunner: CommandRunner {
    /// Answers by argv; the default succeeds.
    var handler: ([String]) -> CommandResult = { _ in CommandResult(status: 0, output: "") }
    private(set) var calls: [[String]] = []
    private(set) var envs: [[String: String]] = []
    private(set) var timeouts: [TimeInterval?] = []

    func run(_ argv: [String], env: [String: String], timeout: TimeInterval?) throws -> CommandResult {
        calls.append(argv)
        envs.append(env)
        timeouts.append(timeout)
        return handler(argv)
    }

    func called(_ needle: String) -> Bool { calls.contains { $0.contains(needle) } }
}

let caFixturePath = "/Users/tester/.portless/ca.pem"
let verifyArgv = TrustStep.verifyArgv(caFixturePath)
let addTrustArgv = TrustStep.addArgv(caFixturePath)
private let visudoArgv = ["/usr/sbin/visudo", "-c", "-f", Sudoers.stagePath]
private let bootoutArgv = ["/bin/launchctl", "bootout", "system/sh.portless.proxy"]
private let bootstrapArgv = ["/bin/launchctl", "bootstrap", "system", LaunchdPlist.path]

final class InstallOpTests: XCTestCase {
    private var fs = RecordingFileOps()
    private var runner = FakeCommandRunner()
    private var copiedInto: URL?
    private var lines: [String] = []

    override func setUp() {
        super.setUp()
        fs = RecordingFileOps()
        runner = FakeCommandRunner()
        copiedInto = nil
        lines = []
        answer()
    }

    /// Untrusted unless a case says otherwise, so the default path exercises
    /// the trust write rather than the already-trusted short circuit.
    private func answer(_ overrides: @escaping ([String]) -> CommandResult? = { _ in nil }) {
        runner.handler = { argv in
            if let answer = overrides(argv) { return answer }
            return argv == verifyArgv
                ? CommandResult(status: 1, output: "not trusted")
                : CommandResult(status: 0, output: "")
        }
    }

    /// The CA exists by default: portless mints it when the daemon starts, and
    /// every case except the fresh-machine one below runs after that.
    private func makeOp(copyFails: Bool = false, caPresent: Bool = true) -> InstallOp {
        if caPresent { fs.existingPaths.insert(caFixturePath) }
        var op = InstallOp(
            bundleRoot: URL(fileURLWithPath: "/Applications/mattstack.app/Contents"),
            user: .fixture(),
            pins: .fixture(),
            fs: fs,
            runner: runner,
            copyPayload: { [self] _, targetRoot, _, _ in
                if copyFails { throw ProxyInstallError("payload refused") }
                copiedInto = targetRoot
            })
        op.emit = { [self] in lines.append($0) }
        op.caWait = 0
        return op
    }

    func testHappyPathRunsTheStepsInOrder() {
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(copiedInto?.path, ProxyPaths.root)
        XCTAssertEqual(runner.calls, [visudoArgv, bootoutArgv, bootstrapArgv, verifyArgv, addTrustArgv])
        XCTAssertEqual(fs.replaced.map(\.to), [LaunchdPlist.path, Sudoers.path])
        XCTAssertEqual(fs.written[LaunchdPlist.stagePath]?.isEmpty, false)
        XCTAssertEqual(
            fs.written[Sudoers.stagePath],
            "tester ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/sh.portless.proxy\n")
        XCTAssertTrue(fs.made.contains(ProxyPaths.logDir))
    }

    // MINOR 3: the mode and owner land on the stage BEFORE it goes into place,
    // never on the live file afterwards.
    func testStagedFilesAreRootModedAndOwnedBeforeGoingIntoPlace() throws {
        _ = makeOp().execute()
        XCTAssertEqual(fs.modes[LaunchdPlist.stagePath], 0o644)
        XCTAssertEqual(fs.modes[Sudoers.stagePath], 0o440)
        XCTAssertEqual(fs.owners[LaunchdPlist.stagePath], "0:0")
        XCTAssertEqual(fs.owners[Sudoers.stagePath], "0:0")
        for (stage, dest) in [(LaunchdPlist.stagePath, LaunchdPlist.path), (Sudoers.stagePath, Sudoers.path)] {
            let chmod = try XCTUnwrap(fs.ops.firstIndex(of: "chmod \(stage)"))
            let chown = try XCTUnwrap(fs.ops.firstIndex(of: "chown \(stage)"))
            let replace = try XCTUnwrap(fs.ops.firstIndex(of: "replace \(dest)"))
            XCTAssertLessThan(chmod, replace)
            XCTAssertLessThan(chown, replace)
        }
    }

    // The whole stdout report, in order: the app parses the last two lines, and
    // the trust line has to sit immediately before the exit trailer main.swift
    // adds.
    func testHappyPathReportsEveryStepAndTheTrustOutcome() {
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(lines, ["copy: ok", "plist: ok", "sudoers: ok", "bootstrap: ok", "trust: ok", "MATTSTACK_TRUST=ok"])
    }

    // Declining the certificate dialog is an answer, not a failure: the install
    // finishes, the proxy runs untrusted, and the outcome travels on its own
    // line for the tool.proxy row to turn into a remedy.
    func testDeclinedTrustStillInstallsAndReportsDeclined() {
        answer { $0 == addTrustArgv ? CommandResult(status: 1, output: "SecTrustSettingsSetTrustSettings: The authorization was canceled by the user.") : nil }
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(lines, [
            "copy: ok", "plist: ok", "sudoers: ok", "bootstrap: ok",
            "trust: declined SecTrustSettingsSetTrustSettings: The authorization was canceled by the user.",
            "MATTSTACK_TRUST=declined",
        ])
        XCTAssertTrue(fs.replaced.contains { $0.to == LaunchdPlist.path })
        XCTAssertFalse(fs.removed.contains(LaunchdPlist.path))
    }

    func testFailedTrustStillInstallsAndReportsFailed() {
        answer { $0 == addTrustArgv ? CommandResult(status: 1, output: "SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.") : nil }
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(lines, [
            "copy: ok", "plist: ok", "sudoers: ok", "bootstrap: ok",
            "trust: failed SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.",
            "MATTSTACK_TRUST=failed",
        ])
    }

    // The daemon mints the CA at startup, so the trust write is the one step
    // whose input this op does not produce. When it never appears the run still
    // succeeds and says so.
    func testMissingCaAfterBootstrapIsReportedAndNotFatal() {
        XCTAssertEqual(makeOp(caPresent: false).execute(), 0)
        XCTAssertEqual(lines.suffix(2), ["trust: failed no CA certificate at \(caFixturePath)", "MATTSTACK_TRUST=failed"])
        XCTAssertFalse(runner.called("add-trusted-cert"))
    }

    // An already-trusted CA must not raise the dialog again: without this every
    // re-install and every version bump would ask for the certificate anew.
    func testAlreadyTrustedSkipsTheWrite() {
        answer { $0 == verifyArgv ? CommandResult(status: 0, output: "") : nil }
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(lines.suffix(2), ["trust: ok (already trusted)", "MATTSTACK_TRUST=ok"])
        XCTAssertFalse(runner.called("add-trusted-cert"))
    }

    // Nobody may ever answer the dialog, and a helper blocked on it holds the
    // escalated session and the Install behind it.
    func testTheTrustWriteIsBounded() throws {
        _ = makeOp().execute()
        let index = try XCTUnwrap(runner.calls.firstIndex(of: addTrustArgv))
        XCTAssertEqual(runner.timeouts[index], 120)
        XCTAssertNil(runner.timeouts[0], "launchctl and visudo answer on their own; only a dialog needs a bound")
    }

    func testCopyFailureStopsBeforeAnythingPrivilegedRuns() {
        XCTAssertEqual(makeOp(copyFails: true).execute(), 70)
        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertTrue(fs.written.isEmpty)
        XCTAssertTrue(fs.replaced.isEmpty)
    }

    // IMPORTANT 1 / finding-1 proof. portless's own `service install` leaves the
    // plist behind, and this dev machine already has it, so a re-install writes
    // over files that exist. With a non-clobbering rename it would throw (the
    // moveItem behavior the fake now reproduces); the atomic replace clobbers.
    func testReinstallOverExistingFilesClobbersAndSucceeds() {
        fs.existingPaths.insert(LaunchdPlist.path)
        fs.existingPaths.insert(Sudoers.path)
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(fs.replaced.map(\.to), [LaunchdPlist.path, Sudoers.path])
    }

    // IMPORTANT 2: the fake reproduces moveItem, so a test cannot pass against
    // behavior RealFileOps could not.
    func testFakeRenameRefusesAnExistingDestinationButReplaceClobbers() {
        fs.existingPaths.insert("/x/dest")
        XCTAssertThrowsError(try fs.rename(from: URL(fileURLWithPath: "/x/src"), to: URL(fileURLWithPath: "/x/dest")))
        XCTAssertNoThrow(try fs.replaceFile(from: URL(fileURLWithPath: "/x/src2"), to: URL(fileURLWithPath: "/x/dest")))
    }

    func testPlistWriteFailureIsFatalAndLeavesNoCandidate() {
        fs.failWritesTo.insert(LaunchdPlist.stagePath)
        XCTAssertEqual(makeOp().execute(), 70)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.stagePath))
        XCTAssertFalse(fs.removed.contains(LaunchdPlist.path))
        XCTAssertFalse(runner.called("-c"))
        XCTAssertFalse(runner.called("bootstrap"))
    }

    // The rendered rule failed validation: it never goes into place, and the run
    // tears back down so no partial privileged state is left (deck's own reload
    // rule would otherwise grant NOPASSWD against a daemon that never came up).
    func testVisudoRejectionTearsDownAndInstallsNoRule() {
        runner.handler = { $0 == visudoArgv ? CommandResult(status: 1, output: "syntax error") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 65)
        XCTAssertTrue(fs.removed.contains(Sudoers.stagePath))
        XCTAssertFalse(fs.replaced.contains { $0.to == Sudoers.path })
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.path))
        XCTAssertTrue(fs.removed.contains(Sudoers.path))
        XCTAssertTrue(runner.called("bootout"))
        XCTAssertFalse(runner.called("bootstrap"))
    }

    // The forbidden state this closes: a plist for a daemon that never
    // bootstrapped (services.ts reads a lone plist as "already installed") and a
    // sudoers rule with no daemon behind it. Both must be gone.
    func testBootstrapFailureLeavesNoForbiddenResidue() {
        runner.handler = { $0 == bootstrapArgv ? CommandResult(status: 1, output: "5: Input/output error") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 71)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.path))
        XCTAssertTrue(fs.removed.contains(Sudoers.path))
    }

    // IMPORTANT 1, the self-inflicted wedge: run A fails at bootstrap mid-upgrade
    // and must leave a state run B installs from cleanly. The old wedge left the
    // sudoers file in place, so run B's non-clobber rename threw 70 forever.
    func testBootstrapFailThenRetrySucceeds() {
        fs.existingPaths.insert(LaunchdPlist.path)
        fs.existingPaths.insert(Sudoers.path)
        runner.handler = { $0 == bootstrapArgv ? CommandResult(status: 1, output: "boom") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 71)
        XCTAssertFalse(fs.existingPaths.contains(LaunchdPlist.path))
        XCTAssertFalse(fs.existingPaths.contains(Sudoers.path))

        runner.handler = { _ in CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 0)
    }

    // bootout has no service to tear down on a first install, so its failure is
    // the normal case, not an error.
    func testBootoutFailureIsIgnored() {
        runner.handler = { $0 == bootoutArgv ? CommandResult(status: 3, output: "No such process") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertTrue(runner.called("bootstrap"))
    }

    // The helper sits at Contents/Helpers/<name>; CopyStep reads Helpers/ off
    // the root it is handed, so the root is Contents.
    func testBundleRootIsTwoLevelsUpFromTheExecutable() {
        XCTAssertEqual(
            InstallOp.bundleRoot(forExecutable: URL(fileURLWithPath: "/Applications/mattstack.app/Contents/Helpers/mattstack-proxy-install")).path,
            "/Applications/mattstack.app/Contents")
    }
}
