import Foundation
import XCTest
@testable import ProxyInstall

// RemoveOp is a sequence of idempotent deletions over the same FileOps/
// CommandRunner seams InstallOp uses (RecordingFileOps/FakeCommandRunner,
// declared in InstallOpTests.swift). The privileged effects themselves
// (launchctl, security, openssl) are proven by the VM leg; this suite is the
// ordering, the idempotency-on-absence claim, and the CA common-name parse.
private let bootoutArgv = ["/bin/launchctl", "bootout", "system/sh.portless.proxy"]
private let opensslArgv = ["/usr/bin/openssl", "x509", "-noout", "-subject", "-in", ProxyPaths.trustedCa]
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

    private func makeOp() -> RemoveOp {
        RemoveOp(fs: fs, runner: runner)
    }

    func testHappyPathRunsTheStepsInOrder() {
        fs.existingPaths.insert(LaunchdPlist.path)
        fs.existingPaths.insert(Sudoers.path)
        fs.existingPaths.insert(ProxyPaths.trustedCa)
        fs.existingPaths.insert(ProxyPaths.root)

        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertEqual(runner.calls, [bootoutArgv, opensslArgv, deleteCertArgv])
        XCTAssertEqual(fs.removed, [LaunchdPlist.path, Sudoers.path, ProxyPaths.root])
    }

    // Every step must be a no-op success when there is nothing there: a
    // second remove (or a remove with no prior install) is not an error.
    func testEverythingAbsentStillSucceeds() {
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
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
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
    }

    func testPlistRemovalFailureIsUnexpectedAndFails() {
        fs.failRemovesOf.insert(LaunchdPlist.path)
        XCTAssertEqual(makeOp().execute(), ExitCode.software)
        // The rest of the sequence never ran past the failure.
        XCTAssertFalse(fs.removed.contains(Sudoers.path))
        XCTAssertFalse(fs.removed.contains(ProxyPaths.root))
    }

    func testSudoersRemovalFailureIsUnexpectedAndFails() {
        fs.failRemovesOf.insert(Sudoers.path)
        XCTAssertEqual(makeOp().execute(), ExitCode.software)
        XCTAssertTrue(fs.removed.contains(LaunchdPlist.path))
        XCTAssertFalse(fs.removed.contains(ProxyPaths.root))
    }

    func testProxyRootRemovalFailureIsUnexpectedAndFails() {
        fs.failRemovesOf.insert(ProxyPaths.root)
        XCTAssertEqual(makeOp().execute(), ExitCode.software)
    }

    // No record of a trusted certificate (an install whose trust dialog was
    // declined, or a machine this helper never touched): nothing to take out
    // of the keychain, and not fatal.
    func testNoTrustRecordSkipsUntrustButRemovesEverythingElse() {
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertFalse(runner.called("openssl"))
        XCTAssertFalse(runner.called("security"))
        XCTAssertEqual(fs.removed, [LaunchdPlist.path, Sudoers.path, ProxyPaths.root])
    }

    // The CN comes from the root-owned copy the trust step recorded. The
    // console user's own ~/.portless/ca.pem is never read: they can replace it
    // with a certificate whose CN names an unrelated System-keychain entry,
    // and this op deletes as root.
    func testUntrustReadsTheRootOwnedRecordAndNotTheUsersCopy() {
        fs.existingPaths.insert(ProxyPaths.trustedCa)
        fs.existingPaths.insert("/Users/tester/.portless/ca.pem")
        _ = makeOp().execute()
        XCTAssertTrue(runner.calls.contains(deleteCertArgv))
        XCTAssertFalse(runner.calls.contains { $0.contains("/Users/tester/.portless/ca.pem") })
    }

    // security delete-certificate returns the same nonzero status whether
    // the cert was already gone or something else went wrong; either way the
    // CA is a convenience, not state this op owns, so it never fails the run.
    func testDeleteCertificateFailureIsNotFatal() {
        fs.existingPaths.insert(ProxyPaths.trustedCa)
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
        fs.existingPaths.insert(ProxyPaths.trustedCa)
        runner.handler = { argv in
            argv == opensslArgv ? CommandResult(status: 1, output: "unable to load certificate") : CommandResult(status: 0, output: "")
        }
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertFalse(runner.called("security"))
    }

    // The exit status can't tell "already gone" apart from a real Keychain
    // failure, so the message reports the status rather than naming a cause
    // it hasn't verified. A stuck-CA incident reads the status, not a guess.
    func testUntrustMessageReportsTheStatusNotAnAssumedCause() {
        XCTAssertEqual(RemoveOp.untrustMessage(deleteStatus: 0), "untrust: ok")
        XCTAssertEqual(
            RemoveOp.untrustMessage(deleteStatus: 1),
            "untrust: delete-certificate failed (status 1), skipping")
        XCTAssertEqual(
            RemoveOp.untrustMessage(deleteStatus: 25),
            "untrust: delete-certificate failed (status 25), skipping")
    }

    func testBootoutMessageReportsTheObservedStatus() {
        XCTAssertEqual(RemoveOp.bootoutMessage(status: 0), "bootout: ok")
        XCTAssertEqual(RemoveOp.bootoutMessage(status: 3), "bootout: status 3, ignoring")
    }
}
