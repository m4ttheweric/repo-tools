import XCTest
import MattstackCoreChecks

final class CoreChecksXCTest: XCTestCase {
    func testAllCoreChecksPass() async {
        let report = await runAllChecks()
        for f in report.failures {
            XCTFail("\(f.check) [\(f.file):\(f.line)]: \(f.message)")
        }
        XCTAssertGreaterThan(report.passed, 0)
    }
}
