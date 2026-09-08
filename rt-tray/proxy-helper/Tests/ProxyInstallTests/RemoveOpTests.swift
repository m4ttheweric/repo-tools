import Foundation
import XCTest
@testable import ProxyInstall

// RemoveOp is a sequence of idempotent deletions over the same FileOps/
// CommandRunner seams InstallOp uses (RecordingFileOps/FakeCommandRunner,
// declared in InstallOpTests.swift). The privileged effects themselves
// (launchctl, security, openssl) are proven by the VM leg; this suite is the
// ordering, the idempotency-on-absence claim, and the CA common-name parse.
private let bootoutArgv = ["/bin/launchctl", "bootout", "system/sh.portless.proxy"]
private let opensslArgv = ["/usr/bin/openssl", "x509", "-noout", "-subject", "-in", "/Users/tester/.portless/ca.pem"]
private let deleteCertArgv = ["/usr/bin/security", "delete-certificate", "-c", "portless Local CA", "/Library/Keychains/System.keychain"]

final class RemoveOpTests: XCTestCase {
    private var fs = RecordingFileOps()
    private var runner = FakeCommandRunner()

    override func setUp() {
        super.setUp()
        fs = RecordingFileOps()
        runner = FakeCommandRunner()
        runner.handler = { argv in
            argv == opensslArgv
                ? CommandResult(status: 0, output: "subject=CN=portless Local CA\n")
                : CommandResult(status: 0, output: "")
        }
    }

    private func makeOp(stateDir: String? = "/Users/tester/.portless") -> RemoveOp {
        RemoveOp(stateDir: stateDir, fs: fs, runner: runner)
    }

    func testHappyPathRunsTheStepsInOrder() {
        fs.existingPaths.insert(LaunchdPlist.path)
        fs.existingPaths.insert(Sudoers.path)
        fs.existingPaths.insert("/Users/tester/.portless/ca.pem")
        fs.existingPaths.insert(ProxyPaths.root)

        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertEqual(runner.calls, [bootoutArgv, opensslArgv, deleteCertArgv])
        XCTAssertEqual(fs.removed, [LaunchdPlist.path, Sudoers.path, ProxyPaths.root])
    }

    // Every step must be a no-op success when there is nothing there: a
    // second remove (or a remove with no prior install) is not an error.
    func testEverythingAbsentStillSucceeds() {
        XCTAssertEqual(makeOp(stateDir: nil).execute(), ExitCode.ok)
        XCTAssertEqual(fs.removed, [LaunchdPlist.path, Sudoers.path, ProxyPaths.root])
        XCTAssertFalse(runner.called("openssl"))
        XCTAssertFalse(runner.called("security"))
    }

    func testBootoutFailureIsIgnored() {
        runner.handler = { argv in
            if argv == bootoutArgv { return CommandResult(status: 3, output: "No such process") }
            if argv == opensslArgv { return CommandResult(status: 0, output: "subject=CN=portless Local CA\n") }
            return CommandResult(status: 0, output: "")
        }
        XCTAssertEqual(makeOp(stateDir: nil).execute(), ExitCode.ok)
    }

    func testPlistRemovalFailureIsUnexpectedAndFails() {
        fs.failRemovesOf.insert(LaunchdPlist.path)
        XCTAssertEqual(makeOp(stateDir: nil).execute(), ExitCode.software)
        // The rest of the sequence never ran past the failure.
        XCTAssertFalse(fs.removed.contains(Sudoers.path))
        XCTAssertFalse(fs.removed.contains(ProxyPaths.root))
    }

    func testSudoersRemovalFailureIsUnexpectedAndFails() {
        fs.failRemovesOf.insert(Sudoers.path)
        XCTAssertEqual(makeOp(stateDir: nil).execute(), ExitCode.software)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.path))
        XCTAssertFalse(fs.removed.contains(ProxyPaths.root))
    }

    func testProxyRootRemovalFailureIsUnexpectedAndFails() {
        fs.failRemovesOf.insert(ProxyPaths.root)
        XCTAssertEqual(makeOp(stateDir: nil).execute(), ExitCode.software)
    }

    // No console user resolved (nobody logged in, or the query failed): the
    // CA cannot be identified, so untrust is skipped, not fatal.
    func testNoConsoleUserSkipsUntrustButRemovesEverythingElse() {
        XCTAssertEqual(makeOp(stateDir: nil).execute(), ExitCode.ok)
        XCTAssertFalse(runner.called("openssl"))
        XCTAssertFalse(runner.called("security"))
        XCTAssertEqual(fs.removed, [LaunchdPlist.path, Sudoers.path, ProxyPaths.root])
    }

    // A console user resolved, but the CA was never deployed (fresh state
    // dir, or a machine that was never trusted): skip, not fatal.
    func testMissingCaFileSkipsUntrust() {
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertFalse(runner.called("openssl"))
        XCTAssertFalse(runner.called("security"))
    }

    // The delete-certificate argv carries the CN parsed out of the CA file,
    // not a hardcoded guess: portless owns that string, this op only reads it.
    func testUntrustResolvesTheCommonNameFromTheStateDirsCaFile() {
        fs.existingPaths.insert("/Users/tester/.portless/ca.pem")
        _ = makeOp().execute()
        XCTAssertTrue(runner.calls.contains(deleteCertArgv))
    }

    // security delete-certificate returns the same nonzero status whether
    // the cert was already gone or something else went wrong; either way the
    // CA is a convenience, not state this op owns, so it never fails the run.
    func testDeleteCertificateFailureIsNotFatal() {
        fs.existingPaths.insert("/Users/tester/.portless/ca.pem")
        runner.handler = { argv in
            if argv == opensslArgv { return CommandResult(status: 0, output: "subject=CN=portless Local CA\n") }
            if argv == deleteCertArgv { return CommandResult(status: 1, output: "not found") }
            return CommandResult(status: 0, output: "")
        }
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
    }

    // A corrupted or unreadable CA file is likewise not fatal: openssl's own
    // failure to parse it means there is nothing valid to untrust.
    func testUnparseableCaFileSkipsUntrust() {
        fs.existingPaths.insert("/Users/tester/.portless/ca.pem")
        runner.handler = { argv in
            argv == opensslArgv ? CommandResult(status: 1, output: "unable to load certificate") : CommandResult(status: 0, output: "")
        }
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertFalse(runner.called("security"))
    }
}
