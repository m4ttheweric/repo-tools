import Foundation
import XCTest
@testable import ProxyInstall

// InstallOp's own subject is the ORDER of the five sub-steps and what each
// failure leaves behind; the steps themselves are proven elsewhere (CopyStep by
// its own suite, the two renderers by their goldens, the privileged commands by
// the VM leg). So both seams are fakes here and nothing touches the disk.
final class RecordingFileOps: FileOps {
    var existingPaths: Set<String> = []
    var failWritesTo: Set<String> = []

    private(set) var written: [String: String] = [:]
    private(set) var renames: [(from: String, to: String)] = []
    private(set) var removed: [String] = []
    private(set) var made: [String] = []
    private(set) var modes: [String: mode_t] = [:]
    private(set) var owners: [String: String] = [:]

    func list(_ root: URL) throws -> [String] { [] }
    func read(_ path: URL) throws -> Data { Data() }

    func stat(_ path: URL) throws -> PathStat? {
        existingPaths.contains(path.path) ? PathStat(uid: 0, isRegularFile: true) : nil
    }

    func mkdir(_ path: URL) throws { made.append(path.path) }
    func copyItem(from: URL, to: URL) throws {}

    func write(_ contents: String, to path: URL) throws {
        if failWritesTo.contains(path.path) { throw ProxyInstallError("write refused: \(path.path)") }
        written[path.path] = contents
    }

    func rename(from: URL, to: URL) throws { renames.append((from: from.path, to: to.path)) }
    func removeTree(_ path: URL) throws { removed.append(path.path) }
    func setMode(_ path: URL, _ mode: mode_t) throws { modes[path.path] = mode }
    func setOwner(_ path: URL, uid: uid_t, gid: gid_t) throws { owners[path.path] = "\(uid):\(gid)" }
}

final class FakeCommandRunner: CommandRunner {
    /// Answers by argv; the default succeeds.
    var handler: ([String]) -> CommandResult = { _ in CommandResult(status: 0, output: "") }
    private(set) var calls: [[String]] = []
    private(set) var envs: [[String: String]] = []

    func run(_ argv: [String], env: [String: String]) throws -> CommandResult {
        calls.append(argv)
        envs.append(env)
        return handler(argv)
    }

    func called(_ needle: String) -> Bool { calls.contains { $0.contains(needle) } }
}

private let trustArgv = [ProxyPaths.node, ProxyPaths.cli, "trust"]
private let visudoArgv = ["/usr/sbin/visudo", "-c", "-f", Sudoers.stagePath]
private let bootoutArgv = ["/bin/launchctl", "bootout", "system/sh.portless.proxy"]
private let bootstrapArgv = ["/bin/launchctl", "bootstrap", "system", LaunchdPlist.path]

final class InstallOpTests: XCTestCase {
    private var fs = RecordingFileOps()
    private var runner = FakeCommandRunner()
    private var copiedInto: URL?

    override func setUp() {
        super.setUp()
        fs = RecordingFileOps()
        runner = FakeCommandRunner()
        copiedInto = nil
    }

    private func makeOp(copyFails: Bool = false) -> InstallOp {
        InstallOp(
            bundleRoot: URL(fileURLWithPath: "/Applications/mattstack.app/Contents"),
            user: .fixture(),
            pins: .fixture(),
            fs: fs,
            runner: runner,
            copyPayload: { [self] _, targetRoot, _, _ in
                if copyFails { throw ProxyInstallError("payload refused") }
                copiedInto = targetRoot
            })
    }

    func testHappyPathRunsTheFiveStepsInOrder() {
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertEqual(copiedInto?.path, ProxyPaths.root)
        XCTAssertEqual(runner.calls, [trustArgv, visudoArgv, bootoutArgv, bootstrapArgv])
        XCTAssertEqual(fs.renames.map(\.to), [LaunchdPlist.path, Sudoers.path])
        XCTAssertEqual(fs.written[LaunchdPlist.stagePath]?.isEmpty, false)
        XCTAssertEqual(
            fs.written[Sudoers.stagePath],
            "tester ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/sh.portless.proxy\n")
        XCTAssertTrue(fs.made.contains(ProxyPaths.logDir))
    }

    func testFilesGetRootOwnershipAndTheirModesBeforeTheRename() {
        _ = makeOp().execute()
        XCTAssertEqual(fs.modes[LaunchdPlist.stagePath], 0o644)
        XCTAssertEqual(fs.modes[Sudoers.stagePath], 0o440)
        XCTAssertEqual(fs.owners[LaunchdPlist.stagePath], "0:0")
        XCTAssertEqual(fs.owners[Sudoers.stagePath], "0:0")
    }

    // The trust run and the daemon share an environment: the same state dir, and
    // the SUDO_* pair portless needs to chown what it writes back to the user.
    func testTrustRunsAgainstTheConsoleUsersStateDir() {
        _ = makeOp().execute()
        let env = runner.envs.first ?? [:]
        XCTAssertEqual(env["PORTLESS_STATE_DIR"], "/Users/tester/.portless")
        XCTAssertEqual(env["SUDO_UID"], "501")
        XCTAssertEqual(env["HOME"], "/Users/tester")
    }

    func testCopyFailureStopsBeforeAnythingPrivilegedRuns() {
        XCTAssertEqual(makeOp(copyFails: true).execute(), 70)
        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertTrue(fs.written.isEmpty)
        XCTAssertTrue(fs.renames.isEmpty)
    }

    // services.ts short-circuits on the plist existing ("already installed"), so
    // a run that writes the plist and then fails must take it back out, or the
    // next Install reports done over a proxy that was never bootstrapped.
    func testTrustFailureRemovesThePlistItJustWrote() {
        runner.handler = { $0 == trustArgv ? CommandResult(status: 1, output: "no CA") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 71)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.path))
        XCTAssertFalse(runner.called("-c"), "visudo ran after trust failed")
    }

    // An upgrade over a working install is the other half: the plist that was
    // there before this run is the previous, working one, and removing it would
    // leave the machine worse off than before the failed upgrade.
    func testTrustFailureKeepsAPlistThatWasAlreadyThere() {
        fs.existingPaths.insert(LaunchdPlist.path)
        runner.handler = { $0 == trustArgv ? CommandResult(status: 1, output: "no CA") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 71)
        XCTAssertFalse(fs.removed.contains(LaunchdPlist.path))
    }

    func testVisudoRejectionDiscardsTheCandidateAndNeverInstallsIt() {
        runner.handler = { $0 == visudoArgv ? CommandResult(status: 1, output: "syntax error") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 65)
        XCTAssertTrue(fs.removed.contains(Sudoers.stagePath))
        XCTAssertFalse(fs.renames.contains { $0.to == Sudoers.path })
        XCTAssertFalse(runner.called("bootstrap"))
    }

    func testBootstrapFailureRemovesThePlistItJustWrote() {
        runner.handler = { $0 == bootstrapArgv ? CommandResult(status: 1, output: "5: Input/output error") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 71)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.path))
    }

    // bootout has no service to tear down on a first install, so its failure is
    // the normal case, not an error.
    func testBootoutFailureIsIgnored() {
        runner.handler = { $0 == bootoutArgv ? CommandResult(status: 3, output: "No such process") : CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), 0)
        XCTAssertTrue(runner.called("bootstrap"))
    }

    func testPlistWriteFailureIsFatalBeforeTrustAndLeavesNoCandidate() {
        fs.failWritesTo.insert(LaunchdPlist.stagePath)
        XCTAssertEqual(makeOp().execute(), 70)
        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.stagePath))
    }

    // The helper sits at Contents/Helpers/<name>; CopyStep reads Helpers/ off
    // the root it is handed, so the root is Contents.
    func testBundleRootIsTwoLevelsUpFromTheExecutable() {
        XCTAssertEqual(
            InstallOp.bundleRoot(forExecutable: URL(fileURLWithPath: "/Applications/mattstack.app/Contents/Helpers/mattstack-proxy-install")).path,
            "/Applications/mattstack.app/Contents")
    }
}
