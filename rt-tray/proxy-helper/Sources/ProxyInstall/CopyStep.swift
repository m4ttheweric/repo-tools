import Foundation

// Install step 1: put the bundled portless payload under a root-owned target.
//
// The bundle is writable by the console user, so nothing read from it is
// trusted twice: the payload is copied into a root-owned staging directory
// FIRST and the pins are checked against the staged bytes, which are the bytes
// that get renamed into place. Verifying the bundle path and then re-reading it
// to copy would leave exactly the swap window this step exists to close.
enum CopyStep {
    static func run(bundleRoot: URL, targetRoot: URL, fs: FileOps, pins: PinsValues) throws {
        let portlessSource = bundleRoot.appendingPathComponent("Helpers/portless-dist")
        // Only the interpreter, as a single regular file. The rest of the node
        // distribution (npm, npx, corepack and their symlinks) has no business
        // in a root-owned tree.
        let nodeSource = bundleRoot.appendingPathComponent("Helpers/node/bin/node")

        // Before anything is written: the staging directory is a sibling of the
        // target, so every existing segment on the way down has to be root-owned
        // and unwritable by anyone else.
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
            if info.isGroupOrWorldWritable {
                throw ProxyInstallError("refusing to install under \(segment.path): writable by group or other")
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
            let stagedPortless = stage.appendingPathComponent("portless-dist")
            let stagedNode = stage.appendingPathComponent("node")
            try fs.copyItem(from: portlessSource, to: stagedPortless)
            try fs.copyItem(from: nodeSource, to: stagedNode)

            // Type before contents: a bundle payload swapped for a symlink would
            // stage as one, hash as whatever it points at, and then be renamed
            // into place as a link out of the root-owned tree.
            guard let portlessInfo = try fs.stat(stagedPortless), portlessInfo.isDirectory, !portlessInfo.isSymlink else {
                throw ProxyInstallError("staged portless-dist is not a directory")
            }
            let portlessHash = try fs.treeHash(stagedPortless)
            guard portlessHash == pins.portlessTreeSha256 else {
                throw ProxyInstallError(
                    "portless-dist hash mismatch: pinned \(pins.portlessTreeSha256), found \(portlessHash)")
            }
            guard let nodeInfo = try fs.stat(stagedNode), nodeInfo.isRegularFile, !nodeInfo.isSymlink else {
                throw ProxyInstallError("staged node is not a regular file")
            }
            let nodeHash = try fs.fileHash(stagedNode)
            guard nodeHash == pins.nodeBinSha256 else {
                throw ProxyInstallError("node hash mismatch: pinned \(pins.nodeBinSha256), found \(nodeHash)")
            }
            Report.step("verified portless \(pins.portlessVersion) and the node binary")

            try fs.write(pins.portlessVersion, to: stage.appendingPathComponent("VERSION"))

            // Content is pinned, modes are not: the tree hash covers path and
            // content only, and copyItem carries the bundle's mode across
            // verbatim, so a payload file the console user made writable would
            // stay writable in the tree a root LaunchDaemon execs from.
            try fs.normalizeTree(stage, uid: 0, gid: 0)
            // The interpreter's mode is set outright rather than inherited: the
            // daemon's ProgramArguments name this file, so a bundle copy that
            // arrived without its executable bit would install a proxy that
            // cannot start.
            try fs.setMode(stagedNode, InstalledMode.executable)

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
