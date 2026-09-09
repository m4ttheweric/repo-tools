import Foundation
import XCTest
@testable import ProxyInstall

final class SudoersTests: XCTestCase {
    func testSudoersGolden() {
        XCTAssertEqual(
            Sudoers.render(user: "tester"),
            "tester ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/sh.portless.proxy\n")
    }

    func testPathsAreTheCompiledInOnes() {
        XCTAssertEqual(Sudoers.path, "/etc/sudoers.d/mattstack-portless")
        // sudo skips any file in sudoers.d whose name contains a dot, so the
        // candidate is inert while visudo is still deciding on it.
        XCTAssertEqual(Sudoers.stagePath, "/etc/sudoers.d/.mattstack-portless.stage")
    }

    func testAcceptsRealisticShortNames() {
        for name in ["tester", "matt", "m.goodwin", "build_agent", "user-1", "u2"] {
            XCTAssertTrue(ConsoleUser.isSafeName(name), "rejected \(name)")
        }
    }

    // The rendered line is a sudoers rule, so a name carrying sudoers syntax
    // grants whatever it says and still passes `visudo -c`.
    func testRejectsNamesThatWouldRewriteTheRule() {
        for name in [
            "", "root ALL=(ALL) NOPASSWD: ALL", "a b", "%admin", "+netgroup", "#501",
            "a\nb ALL=(ALL) NOPASSWD: ALL", "a\\", "-x", "a!b", "a,b",
        ] {
            XCTAssertFalse(ConsoleUser.isSafeName(name), "accepted \(name.debugDescription)")
        }
    }
}
