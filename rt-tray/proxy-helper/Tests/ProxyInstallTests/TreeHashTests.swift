import Foundation
import XCTest
@testable import ProxyInstall

// The one place the real filesystem is exercised: the pin gen-pins.sh writes is
// worthless if this side computes a different digest, and the fake cannot catch
// that. The fixture is built here rather than read from the machine, so the
// expected digest is a constant.
final class TreeHashTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("tree-hash-\(UUID().uuidString)")
        try write("y", "Z/z.txt")
        try write("x", "a b/c/d.txt")
        try write("", "a-b/empty")
        try write("top", "top.js")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func write(_ contents: String, _ relative: String) throws {
        let path = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: path, atomically: true, encoding: .utf8)
    }

    // Produced by scripts/gen-pins.sh's tree_hash() over this same fixture. A
    // change to either definition breaks this, which is the point: a drift that
    // goes unnoticed makes every install refuse a payload that is in fact correct.
    func testTreeHashMatchesTheGenPinsDefinition() throws {
        XCTAssertEqual(
            try RealFileOps().treeHash(root),
            "13b865deac3fd054e5a64d3afaef7dc72efd97f383b672ba8c510e905215e44a")
    }

    func testRefusesNonASCIIPayloadPath() throws {
        try write("z", "caf\u{e9}.txt")
        XCTAssertThrowsError(try RealFileOps().treeHash(root)) {
            XCTAssertTrue("\($0)".contains("non-ASCII"), "got: \($0)")
        }
    }

    func testRefusesSymlinkInPayload() throws {
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("link.js"),
            withDestinationURL: root.appendingPathComponent("top.js"))
        XCTAssertThrowsError(try RealFileOps().treeHash(root)) {
            XCTAssertTrue("\($0)".contains("symlink"), "got: \($0)")
        }
    }
}
