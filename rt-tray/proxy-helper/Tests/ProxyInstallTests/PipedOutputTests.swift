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

    func testInstallTrailerSurvivesPipedStdout() {
        let result = runPiped(["install"])
        XCTAssertEqual(result.reason, .exit)
        XCTAssertTrue(result.output.hasSuffix("MATTSTACK_EXIT=69\n"), "got: \(result.output)")
    }

    func testUsageTrailerSurvivesPipedStdout() {
        let result = runPiped([])
        XCTAssertEqual(result.reason, .exit)
        XCTAssertTrue(result.output.hasSuffix("MATTSTACK_EXIT=64\n"), "got: \(result.output)")
    }
}
