import XCTest
@testable import ProxyInstall

final class ReportTests: XCTestCase {
    func testTrailerLineShape() {
        XCTAssertEqual(Report.trailer(3), "MATTSTACK_EXIT=3")
    }
    func testUsageIsExit64() {
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x"]), .usage)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "bogus"]), .usage)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "--version"]), .version)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "install"]), .install)
        XCTAssertEqual(ProxyInstallMain.parse(argv: ["x", "remove"]), .remove)
    }
}
