import XCTest

// The escalator that runs this helper in production pipes stdout, which is
// exactly the shape Foundation's synchronizeFile() cannot handle. A unit
// test against Report directly cannot catch that: it only reproduces under
// a real child process with its stdout attached to a pipe, hence spawning
// the built binary here instead of calling into ProxyInstall in-process.
final class PipedOutputTests: XCTestCase {
    var productsDirectory: URL {
        for bundle in Bundle.allBundles where bundle.bundlePath.hasSuffix(".xctest") {
            return bundle.bundleURL.deletingLastPathComponent()
        }
        fatalError("couldn't find the products directory")
    }

    func runPiped(_ args: [String]) -> (output: String, reason: Process.TerminationReason) {
        let process = Process()
        process.executableURL = productsDirectory.appendingPathComponent("ProxyInstall")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        try! process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "", process.terminationReason)
    }

    // `install` refuses before it reads anything, so this exercises the real
    // binary's first failure path without touching /Library. Under root there is
    // no refusal to observe and the run would install for real.
    func testInstallRefusesUnescalatedAndStillEmitsTheTrailer() throws {
        try XCTSkipIf(getuid() == 0, "the unescalated refusal path does not exist when the suite runs as root")
        let result = runPiped(["install"])
        XCTAssertEqual(result.reason, .exit)
        XCTAssertTrue(result.output.hasSuffix("MATTSTACK_EXIT=77\n"), "got: \(result.output)")
    }

    // Unlike install, remove has no root gate: every step is individually
    // idempotent against absence, so its unescalated exit code depends on
    // whether this machine already has real state to fail on removing (0 if
    // every path was already absent, 70 at the first path that exists but
    // this process lacks permission to remove). Either outcome proves the
    // real thing this suite is for: the trailer survives the pipe. Skipping
    // under root is not optional here, unlike the other cases: root would
    // actually delete this machine's real launchd/sudoers/keychain state.
    func testRemoveTrailerSurvivesPipedStdout() throws {
        try XCTSkipIf(getuid() == 0, "root would perform the real deletions this test only smokes")
        let result = runPiped(["remove"])
        XCTAssertEqual(result.reason, .exit)
        XCTAssertTrue(
            result.output.hasSuffix("MATTSTACK_EXIT=0\n") || result.output.hasSuffix("MATTSTACK_EXIT=70\n"),
            "got: \(result.output)")
    }

    // The trust verb refuses the same way install does, so its own exit path
    // carries the trailer too.
    func testTrustRefusesUnescalatedAndStillEmitsTheTrailer() throws {
        try XCTSkipIf(getuid() == 0, "the unescalated refusal path does not exist when the suite runs as root")
        let result = runPiped(["trust"])
        XCTAssertEqual(result.reason, .exit)
        XCTAssertTrue(result.output.hasSuffix("MATTSTACK_EXIT=77\n"), "got: \(result.output)")
    }

    func testUsageTrailerSurvivesPipedStdout() {
        let result = runPiped([])
        XCTAssertEqual(result.reason, .exit)
        XCTAssertTrue(result.output.hasSuffix("MATTSTACK_EXIT=64\n"), "got: \(result.output)")
    }
}
