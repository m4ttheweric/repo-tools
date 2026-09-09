import Foundation
import XCTest
@testable import ProxyInstall

// RemoveOp is a sequence of idempotent deletions over the same FileOps/
// CommandRunner seams InstallOp uses (RecordingFileOps/FakeCommandRunner,
// declared in InstallOpTests.swift). The privileged effects themselves
// (launchctl, security, openssl) are proven by the VM leg; this suite is the
// ordering, the idempotency-on-absence claim, and the fingerprint parse.
private let fingerprint = "BC975F413BECEB82741A87035D45250CFC1F9E56"
private let bootoutArgv = ["/bin/launchctl", "bootout", "system/sh.portless.proxy"]
private let opensslArgv = ["/usr/bin/openssl", "x509", "-noout", "-fingerprint", "-sha1", "-in", ProxyPaths.trustedCa]
private let deleteCertArgv = ["/usr/bin/security", "delete-certificate", "-Z", fingerprint, "/Library/Keychains/System.keychain"]

final class RemoveOpTests: XCTestCase {
    private var fs = RecordingFileOps()
    private var runner = FakeCommandRunner()

    override func setUp() {
        super.setUp()
        fs = RecordingFileOps()
        runner = FakeCommandRunner()
        runner.handler = { argv in
            argv == opensslArgv
                ? CommandResult(status: 0, output: "SHA1 Fingerprint=BC:97:5F:41:3B:EC:EB:82:74:1A:87:03:5D:45:25:0C:FC:1F:9E:56\n")
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
        XCTAssertFalse(runner.calls.contains(opensslArgv))
        XCTAssertFalse(runner.calls.contains(deleteCertArgv))
    }

    func testBootoutFailureIsIgnored() {
        runner.handler = { argv in
            if argv == bootoutArgv { return CommandResult(status: 3, output: "No such process") }
            if argv == opensslArgv { return CommandResult(status: 0, output: "SHA1 Fingerprint=BC:97:5F:41:3B:EC:EB:82:74:1A:87:03:5D:45:25:0C:FC:1F:9E:56\n") }
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
        XCTAssertFalse(runner.calls.contains(opensslArgv))
        XCTAssertFalse(runner.calls.contains(deleteCertArgv))
        XCTAssertEqual(fs.removed, [LaunchdPlist.path, Sudoers.path, ProxyPaths.root])
    }

    // The fingerprint comes from the root-owned copy the trust step recorded.
    // The console user's own ~/.portless/ca.pem is never read: they can put
    // any certificate there, and this op deletes as root from the keychain an
    // MDM cert and an enterprise root also live in.
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
            if argv == opensslArgv { return CommandResult(status: 0, output: "SHA1 Fingerprint=BC:97:5F:41:3B:EC:EB:82:74:1A:87:03:5D:45:25:0C:FC:1F:9E:56\n") }
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
        XCTAssertFalse(runner.calls.contains(deleteCertArgv))
    }

    // A common name selects whatever else in the System keychain happens to
    // carry it; the fingerprint selects the one certificate this helper
    // trusted. openssl prints it colon-separated and delete-certificate wants
    // it bare.
    func testTheFingerprintIsParsedBareAndUppercase() {
        XCTAssertEqual(
            RemoveOp.sha1(fromFingerprintLine: "SHA1 Fingerprint=bc:97:5f:41:3b:ec:eb:82:74:1a:87:03:5d:45:25:0c:fc:1f:9e:56\n"),
            fingerprint)
        XCTAssertNil(RemoveOp.sha1(fromFingerprintLine: "unable to load certificate"))
        // Short, long and non-hex all name no certificate at all, and a
        // half-read fingerprint must never reach a root deletion.
        XCTAssertNil(RemoveOp.sha1(fromFingerprintLine: "SHA1 Fingerprint=BC:97:5F"))
        XCTAssertNil(RemoveOp.sha1(fromFingerprintLine: "SHA1 Fingerprint=\(fingerprint)AB"))
        XCTAssertNil(RemoveOp.sha1(fromFingerprintLine: "SHA1 Fingerprint=\(fingerprint.dropLast(2))ZZ"))
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
