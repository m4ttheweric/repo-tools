import Foundation
import XCTest
@testable import ProxyInstall

extension PinsValues {
    static func fixture(treeSha256: String = "cafe", portlessVersion: String = "0.0.0") -> PinsValues {
        PinsValues(
            portlessVersion: portlessVersion,
            portlessTarballSha256: "0000",
            portlessTreeSha256: treeSha256,
            appVersion: "0.0.0-test")
    }
}

// Every assertion here is about the order and shape of CopyStep's operations,
// so the fake answers from canned values rather than a temp directory: the
// swapped-tree and non-root-segment cases cannot be staged on a real disk
// without root.
final class FakeFileOps: FileOps {
    let bundle = URL(fileURLWithPath: "/fake/mattstack.app/Contents")
    let target = URL(fileURLWithPath: "/fake/opt/mattstack/portless")

    private let cannedTreeHash: String
    private let segmentOwner: UInt32
    private let segmentIsSymlink: Bool

    private(set) var renamedIntoPlace = false
    private(set) var stagedSiblingOfTarget = false
    private(set) var written: [String: String] = [:]
    private(set) var copied: [String] = []

    init(treeHash: String = "cafe", targetSegmentOwner: UInt32 = 0, targetSegmentIsSymlink: Bool = false) {
        cannedTreeHash = treeHash
        segmentOwner = targetSegmentOwner
        segmentIsSymlink = targetSegmentIsSymlink
    }

    func list(_ root: URL) throws -> [String] { [] }
    func read(_ path: URL) throws -> Data { Data() }
    func treeHash(_ root: URL) throws -> String { cannedTreeHash }

    func stat(_ path: URL) throws -> PathStat? {
        if path.path == target.path { return nil }
        if path.path == "/" || target.path.hasPrefix(path.path + "/") {
            return PathStat(uid: segmentOwner, isSymlink: segmentIsSymlink)
        }
        return PathStat(uid: 0, isSymlink: false)
    }

    func mkdir(_ path: URL) throws {
        guard path.lastPathComponent.hasPrefix(".proxy-stage-") else { return }
        stagedSiblingOfTarget = path.deletingLastPathComponent().path == target.deletingLastPathComponent().path
    }

    func copyTree(from: URL, to: URL) throws { copied.append(to.lastPathComponent) }
    func write(_ contents: String, to path: URL) throws { written[path.lastPathComponent] = contents }
    func rename(from: URL, to: URL) throws { if to.path == target.path { renamedIntoPlace = true } }
    func removeTree(_ path: URL) throws {}
}

final class CopyStepTests: XCTestCase {
    func testRefusesSwappedTreeWithValidLayout() {
        let pins = PinsValues.fixture(treeSha256: "cafe")
        let fs = FakeFileOps(treeHash: "deadbeef")
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: pins)) {
            XCTAssertTrue("\($0)".contains("hash mismatch"), "got: \($0)")
        }
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    func testRefusesNonRootOwnedTargetSegment() {
        let fs = FakeFileOps(targetSegmentOwner: 501)
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture()))
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    func testRefusesSymlinkTargetSegment() {
        let fs = FakeFileOps(targetSegmentIsSymlink: true)
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture()))
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    func testHappyPathStagesThenRenamesAndWritesVersion() throws {
        let pins = PinsValues.fixture(treeSha256: "cafe", portlessVersion: "9.9.9")
        let fs = FakeFileOps(treeHash: "cafe")
        try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: pins)
        XCTAssertTrue(fs.renamedIntoPlace)
        XCTAssertTrue(fs.stagedSiblingOfTarget)
        XCTAssertEqual(fs.written["VERSION"], "9.9.9")
        XCTAssertEqual(fs.copied, ["portless-dist", "node"])
    }
}
