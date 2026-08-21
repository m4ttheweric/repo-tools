import Foundation
import MattstackCoreChecks

let filter = CommandLine.arguments.dropFirst().first
let report = await runAllChecks(filter: filter)
for f in report.failures {
    FileHandle.standardError.write(Data("FAIL \(f.check): \(f.message) (\(f.file):\(f.line))\n".utf8))
}
print("checks: \(report.passed) passed, \(report.failures.count) failed")
exit(report.ok ? 0 : 1)
