import CryptoKit
import Foundation

// Reported to the escalator as a plain stdout line, so the message is the whole
// contract: no domain, no code, nothing a caller is expected to switch on.
struct ProxyInstallError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

struct PathStat: Equatable {
    let uid: UInt32
    let isSymlink: Bool
    let isRegularFile: Bool
    let isDirectory: Bool
    let isGroupOrWorldWritable: Bool

    init(
        uid: UInt32,
        isSymlink: Bool = false,
        isRegularFile: Bool = false,
        isDirectory: Bool = false,
        isGroupOrWorldWritable: Bool = false
    ) {
        self.uid = uid
        self.isSymlink = isSymlink
        self.isRegularFile = isRegularFile
        self.isDirectory = isDirectory
        self.isGroupOrWorldWritable = isGroupOrWorldWritable
    }
}

// The filesystem seam. CopyStep runs as root over paths a non-root user can
// influence, so every read and every mutation goes through here and can be
// driven from a test without root.
protocol FileOps {
    /// Regular files under `root`, as paths relative to it.
    func list(_ root: URL) throws -> [String]
    func read(_ path: URL) throws -> Data
    /// nil when the path does not exist. Never follows a final symlink.
    func stat(_ path: URL) throws -> PathStat?
    func mkdir(_ path: URL) throws
    /// Copies a file or a directory tree. A symlink is copied as a symlink, so
    /// the staged copy still reports one to stat.
    func copyItem(from: URL, to: URL) throws
    func write(_ contents: String, to path: URL) throws
    func rename(from: URL, to: URL) throws
    func removeTree(_ path: URL) throws
    func treeHash(_ root: URL) throws -> String
    func fileHash(_ path: URL) throws -> String
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

extension FileOps {
    /// sha256 over "<relative path>\n<sha256(content) hex>\n" for every regular
    /// file, concatenated in byte order of the relative path. Paths are
    /// ASCII-only (list rejects the rest), which is what makes byte order and
    /// the shell's LC_ALL=C sort the same order.
    ///
    /// Parity anchor: tree_hash() in scripts/gen-pins.sh computes the pin this
    /// is compared against. The two definitions must stay byte-identical or
    /// every install refuses a payload that is in fact correct.
    func treeHash(_ root: URL) throws -> String {
        var hasher = SHA256()
        for rel in try list(root).sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
            let hex = sha256Hex(try read(root.appendingPathComponent(rel)))
            hasher.update(data: Data("\(rel)\n\(hex)\n".utf8))
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    func fileHash(_ path: URL) throws -> String { sha256Hex(try read(path)) }
}

struct RealFileOps: FileOps {
    private let fm = FileManager.default

    func list(_ root: URL) throws -> [String] {
        let base = root.standardizedFileURL.path
        guard let walk = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey],
            options: []
        ) else {
            throw ProxyInstallError("cannot enumerate \(root.path)")
        }
        var out: [String] = []
        for case let url as URL in walk {
            let kind = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            // A symlink hashes as neither its own bytes nor its target's, so a
            // payload carrying one cannot be described by the pin at all.
            if kind.isSymbolicLink == true { throw ProxyInstallError("symlink in payload: \(url.path)") }
            if kind.isDirectory == true { continue }
            guard kind.isRegularFile == true else {
                throw ProxyInstallError("non-regular file in payload: \(url.path)")
            }
            let full = url.standardizedFileURL.path
            guard full.hasPrefix(base + "/") else {
                throw ProxyInstallError("payload entry escaped \(base): \(full)")
            }
            let rel = String(full.dropFirst(base.count + 1))
            // Foundation hands back decomposed (NFD) names while gen-pins.sh's
            // find hands back the bytes on disk, so a non-ASCII name would hash
            // differently on the two sides of the pin. Refusing it keeps the
            // parity total instead of approximate.
            guard rel.utf8.allSatisfy({ $0 >= 0x20 && $0 <= 0x7e }) else {
                throw ProxyInstallError("non-ASCII or control character in payload path: \(rel)")
            }
            out.append(rel)
        }
        return out
    }

    func read(_ path: URL) throws -> Data { try Data(contentsOf: path) }

    func stat(_ path: URL) throws -> PathStat? {
        var info = Darwin.stat()
        guard lstat(path.path, &info) == 0 else {
            if errno == ENOENT || errno == ENOTDIR { return nil }
            throw ProxyInstallError("lstat(\(path.path)): \(String(cString: strerror(errno)))")
        }
        return PathStat(
            uid: info.st_uid,
            isSymlink: (info.st_mode & S_IFMT) == S_IFLNK,
            isRegularFile: (info.st_mode & S_IFMT) == S_IFREG,
            isDirectory: (info.st_mode & S_IFMT) == S_IFDIR,
            isGroupOrWorldWritable: (info.st_mode & (S_IWGRP | S_IWOTH)) != 0)
    }

    func mkdir(_ path: URL) throws {
        try fm.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    }

    func copyItem(from: URL, to: URL) throws { try fm.copyItem(at: from, to: to) }

    func write(_ contents: String, to path: URL) throws {
        try contents.write(to: path, atomically: true, encoding: .utf8)
    }

    func rename(from: URL, to: URL) throws { try fm.moveItem(at: from, to: to) }

    func removeTree(_ path: URL) throws {
        guard try stat(path) != nil else { return }
        try fm.removeItem(at: path)
    }
}
