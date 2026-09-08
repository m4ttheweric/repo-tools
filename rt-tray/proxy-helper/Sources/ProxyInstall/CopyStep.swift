import Foundation

// Install step 1: put the bundled portless payload under a root-owned target.
// This runs with root privileges against a path the console user can reach, so
// it verifies before it writes and never writes anywhere but a staging sibling
// it renames into place.
enum CopyStep {
    static func run(bundleRoot: URL, targetRoot: URL, fs: FileOps, pins: PinsValues) throws {
        let portlessDist = bundleRoot.appendingPathComponent("Helpers/portless-dist")
        let node = bundleRoot.appendingPathComponent("Helpers/node")
        for source in [portlessDist, node] {
            if try fs.stat(source) == nil {
                throw ProxyInstallError("bundled payload missing at \(source.path)")
            }
        }

        // The tarball sha in the pins guards fetch time; this guards install
        // time, where the bundle has already been unpacked and could have been
        // swapped for a tree with the same layout.
        let found = try fs.treeHash(portlessDist)
        guard found == pins.portlessTreeSha256 else {
            throw ProxyInstallError(
                "portless-dist hash mismatch: pinned \(pins.portlessTreeSha256), found \(found)")
        }
        Report.step("verified portless \(pins.portlessVersion) (tree \(String(found.prefix(12))))")

        var targetExists = false
        let target = targetRoot.standardizedFileURL
        for segment in ancestorsIncludingSelf(of: target) {
            guard let info = try fs.stat(segment) else { continue }
            if info.isSymlink {
                throw ProxyInstallError("refusing to install under symlink \(segment.path)")
            }
            if info.uid != 0 {
                throw ProxyInstallError("refusing to install under \(segment.path): owned by uid \(info.uid), not root")
            }
            if segment.path == target.path { targetExists = true }
        }

        let parent = target.deletingLastPathComponent()
        if try fs.stat(parent) == nil { try fs.mkdir(parent) }
        let pid = ProcessInfo.processInfo.processIdentifier
        let stage = parent.appendingPathComponent(".proxy-stage-\(pid)")
        let retired = parent.appendingPathComponent(".proxy-old-\(pid)")
        try fs.removeTree(stage)
        try fs.mkdir(stage)
        do {
            try fs.copyTree(from: portlessDist, to: stage.appendingPathComponent("portless-dist"))
            try fs.copyTree(from: node, to: stage.appendingPathComponent("node"))
            try fs.write(pins.portlessVersion, to: stage.appendingPathComponent("VERSION"))
            // rename(2) will not replace a non-empty directory, so an upgrade
            // moves the old tree aside first and puts it back if the swap fails.
            if targetExists { try fs.rename(from: target, to: retired) }
            do {
                try fs.rename(from: stage, to: target)
            } catch {
                if targetExists {
                    do { try fs.rename(from: retired, to: target) }
                    catch { Report.step("rollback failed; the previous install is at \(retired.path)") }
                }
                throw error
            }
            if targetExists {
                do { try fs.removeTree(retired) }
                catch { Report.step("installed, but the previous copy is still at \(retired.path)") }
            }
        } catch {
            do { try fs.removeTree(stage) }
            catch { Report.step("staging left behind at \(stage.path)") }
            throw error
        }
        Report.step("installed \(target.path)")
    }

    static func ancestorsIncludingSelf(of url: URL) -> [URL] {
        var chain: [URL] = []
        var current = url.standardizedFileURL
        while true {
            chain.append(current)
            let parent = current.deletingLastPathComponent().standardizedFileURL
            if parent.path == current.path { break }
            current = parent
        }
        return chain.reversed()
    }
}
