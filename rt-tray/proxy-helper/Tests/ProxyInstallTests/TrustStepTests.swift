import Foundation
import XCTest
@testable import ProxyInstall

// The trust write is the one step macOS will not let any of us perform without
// asking, so what it does with each answer is the contract: the wording of the
// line, the MATTSTACK_TRUST value, and (for the verb) that it touches nothing
// else on the machine.
final class TrustStepTests: XCTestCase {
    private var fs = RecordingFileOps()
    private var runner = FakeCommandRunner()
    private var lines: [String] = []

    override func setUp() {
        super.setUp()
        fs = RecordingFileOps()
        runner = FakeCommandRunner()
        lines = []
        fs.existingPaths.insert(caFixturePath)
        runner.handler = { argv in
            argv == verifyArgv ? CommandResult(status: 1, output: "not trusted") : CommandResult(status: 0, output: "")
        }
    }

    private func makeOp() -> TrustOp {
        var op = TrustOp(caPath: caFixturePath, fs: fs, runner: runner)
        op.emit = { [self] in lines.append($0) }
        return op
    }

    func testTrustedRunReportsOkAndExitsZero() {
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertEqual(lines, ["trust: ok", "MATTSTACK_TRUST=ok"])
    }

    // Declining is an answer: the row keeps its Retry, so the run that carried
    // the refusal is not itself a failure.
    func testDeclinedRunReportsDeclinedAndExitsZero() {
        runner.handler = { argv in
            argv == addTrustArgv
                ? CommandResult(status: 1, output: "SecTrustSettingsSetTrustSettings: The authorization was cancelled by the user.")
                : CommandResult(status: 1, output: "not trusted")
        }
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertEqual(lines, [
            "trust: declined SecTrustSettingsSetTrustSettings: The authorization was cancelled by the user.",
            "MATTSTACK_TRUST=declined",
        ])
    }

    func testFailedRunReportsFailedAndExitsNonZero() {
        runner.handler = { argv in
            argv == addTrustArgv
                ? CommandResult(status: 1, output: "SecTrustSettingsSetTrustSettings: The authorization was denied since no user interaction was possible.")
                : CommandResult(status: 1, output: "not trusted")
        }
        XCTAssertEqual(makeOp().execute(), ExitCode.osErr)
        XCTAssertEqual(lines.last, "MATTSTACK_TRUST=failed")
    }

    func testMissingCaIsANonZeroRunThatNeverCallsSecurity() {
        fs.existingPaths.remove(caFixturePath)
        XCTAssertEqual(makeOp().execute(), ExitCode.osErr)
        XCTAssertEqual(lines, ["trust: failed no CA certificate at \(caFixturePath)", "MATTSTACK_TRUST=failed"])
        XCTAssertTrue(runner.calls.isEmpty)
    }

    // The verb is the Retry behind one row, invoked on a machine that is
    // already installed and running: anything beyond the trust write and the
    // record of what it trusted would be a side effect nobody asked for.
    func testTheVerbTouchesNothingButTrustSettingsAndItsOwnRecord() {
        _ = makeOp().execute()
        XCTAssertEqual(runner.calls, [verifyArgv, addTrustArgv])
        XCTAssertEqual(fs.copies.map(\.to), [ProxyPaths.trustedCaStage])
        XCTAssertEqual(fs.removed, [ProxyPaths.trustedCaStage], "only the stage it is about to write")
        XCTAssertEqual(fs.replaced.map(\.to), [ProxyPaths.trustedCa])
        XCTAssertTrue(fs.written.isEmpty)
        XCTAssertTrue(fs.made.isEmpty)
    }

    // The verb is the one route a declined machine takes to become trusted
    // later, so it has to leave the same record an install would.
    func testTheVerbRecordsTheCertificateItTrusted() {
        _ = makeOp().execute()
        XCTAssertEqual(fs.copies.first?.from, caFixturePath)
        XCTAssertEqual(fs.modes[ProxyPaths.trustedCaStage], 0o644)
        XCTAssertEqual(fs.owners[ProxyPaths.trustedCaStage], "0:0")
        XCTAssertTrue(fs.replaced.contains { $0.from == ProxyPaths.trustedCaStage && $0.to == ProxyPaths.trustedCa })
    }

    // The console user owns their ca.pem and can replace it between two reads
    // of it, so neither privileged call may name it: a keychain write checked
    // against one file and performed against another is the whole hazard.
    func testTheTrustCallsNameTheRootOwnedCopyAndNotTheUsersFile() {
        _ = makeOp().execute()
        XCTAssertFalse(runner.calls.contains { $0.contains(caFixturePath) })
    }

    // copyItem preserves a symlink as a symlink, and chmod and chown both
    // follow a final symlink: staging one would re-own whatever it points at,
    // as root, on the console user's word.
    func testASymlinkedCaIsRefusedBeforeAnythingIsCopied() {
        fs.symlinkPaths.insert(caFixturePath)
        XCTAssertEqual(makeOp().execute(), ExitCode.osErr)
        XCTAssertEqual(lines, ["trust: failed \(caFixturePath) is not a regular file", "MATTSTACK_TRUST=failed"])
        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertTrue(fs.copies.isEmpty)
    }

    // Without the root-owned copy there is no certificate this helper can
    // vouch for having read twice, so it never asks macOS to trust one.
    func testAStagingFailureIsAFailedRunThatNeverAsks() {
        fs.failRemovesOf.insert(ProxyPaths.trustedCaStage)
        XCTAssertEqual(makeOp().execute(), ExitCode.osErr)
        XCTAssertTrue(runner.calls.isEmpty)
        XCTAssertEqual(lines.last, "MATTSTACK_TRUST=failed")
        XCTAssertTrue(lines.first?.hasPrefix("trust: failed could not stage") == true, "got: \(lines)")
    }

    func testAlreadyTrustedIsReportedWithoutAskingAgain() {
        runner.handler = { _ in CommandResult(status: 0, output: "") }
        XCTAssertEqual(makeOp().execute(), ExitCode.ok)
        XCTAssertEqual(lines, ["trust: ok (already trusted)", "MATTSTACK_TRUST=ok"])
        XCTAssertEqual(runner.calls, [verifyArgv])
    }

    // "denied since no user interaction was possible" is a headless refusal,
    // not a person saying no; only a real cancel reads as declined.
    func testOnlyACancelledAuthorizationReadsAsDeclined() {
        XCTAssertTrue(TrustStep.isDeclined("The authorization was canceled by the user."))
        XCTAssertTrue(TrustStep.isDeclined("The authorization was cancelled by the user."))
        XCTAssertTrue(TrustStep.isDeclined("error -60006"))
        XCTAssertFalse(TrustStep.isDeclined("The authorization was denied since no user interaction was possible."))
        XCTAssertFalse(TrustStep.isDeclined("timed out after 120s"))
    }

    func testTheArgvIsTheAdminDomainTrustRootWrite() {
        XCTAssertEqual(TrustStep.addArgv("/x/ca.pem"), [
            "/usr/bin/security", "add-trusted-cert", "-d", "-r", "trustRoot",
            "-k", "/Library/Keychains/System.keychain", "/x/ca.pem",
        ])
        // -l allows a CA as the leaf, which is what a root certificate checked
        // on its own is; -L keeps the check off the network.
        XCTAssertEqual(TrustStep.verifyArgv("/x/ca.pem"), ["/usr/bin/security", "verify-cert", "-c", "/x/ca.pem", "-L", "-l", "-p", "ssl"])
    }
}
