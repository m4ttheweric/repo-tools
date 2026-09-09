import Foundation
import XCTest
@testable import ProxyInstall

// The mode policy has to be exercised against a real directory: chmod's effect
// is the whole claim, and a fake that records the call proves nothing about it.
// Ownership is passed as this process's own uid/gid, since a non-root suite
// cannot chown to root; that CopyStep passes 0/0 is CopyStepTests' assertion.
final class NormalizeTreeTests: XCTestCase {
    private var root: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("normalize-\(UUID().uuidString)")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? fm.removeItem(at: root)
    }

    private func file(_ relative: String, _ mode: mode_t) throws -> URL {
        let path = root.appendingPathComponent(relative)
        try fm.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        XCTAssertTrue(fm.createFile(atPath: path.path, contents: Data("x".utf8)))
        XCTAssertEqual(chmod(path.path, mode), 0)
        return path
    }

    private func mode(of path: URL) throws -> mode_t {
        var info = Darwin.stat()
        XCTAssertEqual(lstat(path.path, &info), 0, "lstat \(path.path)")
        return info.st_mode & 0o7777
    }

    private func normalize() throws {
        try RealFileOps().normalizeTree(root, uid: getuid(), gid: getgid())
    }

    // The finding this closes: `chmod 666` on a bundle payload file rode
    // through copyItem into the root-owned tree, where a root LaunchDaemon
    // execs it and the console user could rewrite it at will.
    func testAWorldWritablePayloadFileLands644() throws {
        let loose = try file("portless-dist/dist/cli.js", 0o666)
        try normalize()
        XCTAssertEqual(try mode(of: loose), 0o644)
    }

    func testTheInterpreterStaysExecutable() throws {
        let node = try file("node", 0o755)
        try normalize()
        XCTAssertEqual(try mode(of: node), 0o755)
    }

    // Executable and group-writable at once: the executable bit survives, the
    // group-writable one does not.
    func testAGroupWritableExecutableLands755() throws {
        let loose = try file("portless-dist/bin/tool", 0o775)
        try normalize()
        XCTAssertEqual(try mode(of: loose), 0o755)
    }

    func testDirectoriesIncludingTheRootLand755() throws {
        let nested = root.appendingPathComponent("portless-dist/dist")
        try fm.createDirectory(at: nested, withIntermediateDirectories: true)
        XCTAssertEqual(chmod(nested.path, 0o777), 0)
        XCTAssertEqual(chmod(root.path, 0o777), 0)
        try normalize()
        XCTAssertEqual(try mode(of: nested), 0o755)
        XCTAssertEqual(try mode(of: root), 0o755)
    }

    // chmod and chown follow a final symlink, so a link in the staged tree
    // would re-mode its target instead of itself.
    func testRefusesASymlinkInTheTree() throws {
        let outside = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("normalize-outside-\(UUID().uuidString)")
        XCTAssertTrue(fm.createFile(atPath: outside.path, contents: Data("x".utf8)))
        defer { try? fm.removeItem(at: outside) }
        XCTAssertEqual(chmod(outside.path, 0o600), 0)
        try fm.createSymbolicLink(at: root.appendingPathComponent("link.js"), withDestinationURL: outside)

        XCTAssertThrowsError(try normalize()) {
            XCTAssertTrue("\($0)".contains("symlink"), "got: \($0)")
        }
        XCTAssertEqual(try mode(of: outside), 0o600, "the link's target keeps its own mode")
    }
}
