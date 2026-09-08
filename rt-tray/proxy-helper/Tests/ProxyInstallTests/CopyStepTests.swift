import Foundation
import XCTest
@testable import ProxyInstall

extension PinsValues {
    static func fixture(
        treeSha256: String = "cafe",
        portlessVersion: String = "0.0.0",
        nodeBinSha256: String = "n0de"
    ) -> PinsValues {
        PinsValues(
            portlessVersion: portlessVersion,
            portlessTarballSha256: "0000",
            portlessTreeSha256: treeSha256,
            nodeBinSha256: nodeBinSha256,
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
    private let cannedNodeHash: String
    private let segmentOwner: UInt32
    private let segmentIsSymlink: Bool
    private let segmentIsGroupOrWorldWritable: Bool
    private let targetAlreadyInstalled: Bool
    private let stagedNodeIsSymlink: Bool
    private let stagedPortlessIsSymlink: Bool

    private(set) var stageRoot: URL?
    private(set) var log: [String] = []
    private(set) var written: [String: String] = [:]
    private(set) var renames: [(from: String, to: String)] = []
    private(set) var removed: [String] = []
    private(set) var treeHashedPath: URL?
    // Models moveItem's non-clobber semantics: rename onto a path in here throws,
    // so a CopyStep test cannot pass against a rename RealFileOps would refuse.
    private var livePaths: Set<String> = []

    var renamedIntoPlace: Bool { renames.contains { $0.to == target.path } }
    var stagedSiblingOfTarget: Bool {
        guard let stage = stageRoot else { return false }
        return stage.deletingLastPathComponent().path == target.deletingLastPathComponent().path
    }

    init(
        treeHash: String = "cafe",
        nodeHash: String = "n0de",
        targetSegmentOwner: UInt32 = 0,
        targetSegmentIsSymlink: Bool = false,
        targetSegmentIsGroupOrWorldWritable: Bool = false,
        targetAlreadyInstalled: Bool = false,
        stagedNodeIsSymlink: Bool = false,
        stagedPortlessIsSymlink: Bool = false
    ) {
        cannedTreeHash = treeHash
        cannedNodeHash = nodeHash
        segmentOwner = targetSegmentOwner
        segmentIsSymlink = targetSegmentIsSymlink
        segmentIsGroupOrWorldWritable = targetSegmentIsGroupOrWorldWritable
        self.targetAlreadyInstalled = targetAlreadyInstalled
        self.stagedNodeIsSymlink = stagedNodeIsSymlink
        self.stagedPortlessIsSymlink = stagedPortlessIsSymlink
        if targetAlreadyInstalled { livePaths = [target.path] }
    }

    func list(_ root: URL) throws -> [String] { [] }
    func read(_ path: URL) throws -> Data { Data() }

    func treeHash(_ root: URL) throws -> String {
        treeHashedPath = root
        log.append("treeHash \(root.lastPathComponent)")
        return cannedTreeHash
    }

    func fileHash(_ path: URL) throws -> String {
        log.append("fileHash \(path.lastPathComponent)")
        return cannedNodeHash
    }

    func stat(_ path: URL) throws -> PathStat? {
        if path.path == target.path {
            return targetAlreadyInstalled ? PathStat(uid: 0, isDirectory: true) : nil
        }
        if let stage = stageRoot {
            if path.path == stage.appendingPathComponent("node").path {
                return PathStat(uid: 0, isSymlink: stagedNodeIsSymlink, isRegularFile: !stagedNodeIsSymlink)
            }
            if path.path == stage.appendingPathComponent("portless-dist").path {
                return PathStat(
                    uid: 0,
                    isSymlink: stagedPortlessIsSymlink,
                    isDirectory: !stagedPortlessIsSymlink)
            }
        }
        if path.path == "/" || target.path.hasPrefix(path.path + "/") {
            return PathStat(
                uid: segmentOwner,
                isSymlink: segmentIsSymlink,
                isDirectory: true,
                isGroupOrWorldWritable: segmentIsGroupOrWorldWritable)
        }
        return PathStat(uid: 0, isDirectory: true)
    }

    func mkdir(_ path: URL) throws {
        log.append("mkdir \(path.lastPathComponent)")
        if path.lastPathComponent.hasPrefix(".proxy-stage-") { stageRoot = path }
    }

    func copyItem(from: URL, to: URL) throws { log.append("copy \(to.lastPathComponent)") }

    func write(_ contents: String, to path: URL) throws {
        log.append("write \(path.lastPathComponent)")
        written[path.path] = contents
    }

    func rename(from: URL, to: URL) throws {
        if livePaths.contains(to.path) {
            throw ProxyInstallError("moveItem: \(to.path) already exists")
        }
        livePaths.remove(from.path)
        livePaths.insert(to.path)
        log.append("rename \(from.lastPathComponent)")
        renames.append((from: from.path, to: to.path))
    }

    // CopyStep moves directory trees, never single files, so it never calls this.
    func replaceFile(from: URL, to: URL) throws {
        livePaths.remove(from.path)
        livePaths.insert(to.path)
        log.append("replace \(to.lastPathComponent)")
        renames.append((from: from.path, to: to.path))
    }

    func removeTree(_ path: URL) throws {
        livePaths.remove(path.path)
        log.append("remove \(path.lastPathComponent)")
        removed.append(path.path)
    }

    // CopyStep takes the modes it needs from mkdir and the copy; these exist for
    // the single-file writes InstallOp does.
    func setMode(_ path: URL, _ mode: mode_t) throws { log.append("chmod \(path.lastPathComponent)") }
    func setOwner(_ path: URL, uid: uid_t, gid: gid_t) throws { log.append("chown \(path.lastPathComponent)") }
}

final class CopyStepTests: XCTestCase {
    func testRefusesSwappedTreeWithValidLayout() throws {
        let pins = PinsValues.fixture(treeSha256: "cafe")
        let fs = FakeFileOps(treeHash: "deadbeef")
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: pins)) {
            XCTAssertTrue("\($0)".contains("hash mismatch"), "got: \($0)")
        }
        XCTAssertFalse(fs.renamedIntoPlace)
        // The refused bytes are already staged by then, so the cleanup matters.
        XCTAssertTrue(fs.removed.contains(try XCTUnwrap(fs.stageRoot).path))
    }

    // The bundle is writable by the console user, so hashing the bundle path and
    // then re-reading it to copy would verify bytes other than the installed
    // ones. The hash has to come from the staged copy.
    func testVerifiesTheStagedCopyNotTheBundlePath() throws {
        let fs = FakeFileOps(treeHash: "cafe")
        try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture(treeSha256: "cafe"))
        let stage = try XCTUnwrap(fs.stageRoot)
        XCTAssertEqual(
            try XCTUnwrap(fs.treeHashedPath).path,
            stage.appendingPathComponent("portless-dist").path)
        let copied = try XCTUnwrap(fs.log.firstIndex(of: "copy portless-dist"))
        let hashed = try XCTUnwrap(fs.log.firstIndex(of: "treeHash portless-dist"))
        XCTAssertLessThan(copied, hashed)
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

    func testRefusesGroupOrWorldWritableTargetSegment() {
        let fs = FakeFileOps(targetSegmentIsGroupOrWorldWritable: true)
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture())) {
            XCTAssertTrue("\($0)".contains("writable by group or other"), "got: \($0)")
        }
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    func testRefusesSymlinkedStagedNode() {
        let fs = FakeFileOps(stagedNodeIsSymlink: true)
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture())) {
            XCTAssertTrue("\($0)".contains("not a regular file"), "got: \($0)")
        }
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    // A symlinked payload would hash as whatever it points at and then be
    // renamed into place as a link out of the root-owned tree.
    func testRefusesSymlinkedStagedPortlessDist() {
        let fs = FakeFileOps(stagedPortlessIsSymlink: true)
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture())) {
            XCTAssertTrue("\($0)".contains("not a directory"), "got: \($0)")
        }
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    func testRefusesSwappedNodeBinary() {
        let fs = FakeFileOps(nodeHash: "deadbeef")
        XCTAssertThrowsError(try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture())) {
            XCTAssertTrue("\($0)".contains("node hash mismatch"), "got: \($0)")
        }
        XCTAssertFalse(fs.renamedIntoPlace)
    }

    func testHappyPathStagesThenRenamesAndWritesVersion() throws {
        let pins = PinsValues.fixture(treeSha256: "cafe", portlessVersion: "9.9.9")
        let fs = FakeFileOps(treeHash: "cafe")
        try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: pins)
        XCTAssertTrue(fs.renamedIntoPlace)
        XCTAssertTrue(fs.stagedSiblingOfTarget)
        let stage = try XCTUnwrap(fs.stageRoot)
        XCTAssertEqual(fs.written[stage.appendingPathComponent("VERSION").path], "9.9.9")
        XCTAssertNil(fs.written[fs.target.appendingPathComponent("VERSION").path])
        XCTAssertEqual(fs.log.filter { $0.hasPrefix("copy ") }, ["copy portless-dist", "copy node"])
    }

    func testUpgradeRetiresTheExistingInstallThenRenames() throws {
        let fs = FakeFileOps(treeHash: "cafe", targetAlreadyInstalled: true)
        try CopyStep.run(bundleRoot: fs.bundle, targetRoot: fs.target, fs: fs, pins: .fixture(treeSha256: "cafe"))
        let retired = try XCTUnwrap(fs.renames.first)
        XCTAssertEqual(retired.from, fs.target.path)
        XCTAssertTrue(retired.to.contains("/.proxy-old-"), "got: \(retired.to)")
        XCTAssertTrue(fs.renamedIntoPlace)
        XCTAssertTrue(fs.removed.contains(retired.to))
    }
}
