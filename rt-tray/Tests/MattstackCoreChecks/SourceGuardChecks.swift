import Foundation
import MattstackCore

/// No check file may name a process we must never spawn from a test, and
/// none may construct the real runner. Paths are relative to this file.
let sourceGuardChecks: [Check] = [
    Check("checks never name launchctl/pkill/tccutil/osascript/open(1) or SystemCommandRunner") { c in
        let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let files = try FileManager.default.contentsOfDirectory(atPath: here.path).filter { $0.hasSuffix(".swift") && $0 != "SourceGuardChecks.swift" }
        let forbidden = ["/bin/launchctl", "launchctl ", "pkill", "tccutil", "osascript", "/usr/bin/open", "SystemCommandRunner("]
        for f in files {
            let text = try String(contentsOfFile: here.appendingPathComponent(f).path, encoding: .utf8)
            for needle in forbidden where text.contains(needle) {
                c.fail("\(f) mentions forbidden '\(needle)'")
            }
        }
        c.expect(files.count >= 5)
    },
]
