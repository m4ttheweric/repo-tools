import Foundation
import XCTest
@testable import ProxyInstall

// The golden is a transcription of the plist `portless service install` writes
// itself (captured from a real install: label, the `proxy start` argv with its
// flags, and the PORTLESS_* / HOME / SUDO_* environment). Three things differ
// deliberately and are asserted here so a drift is a test failure:
// an explicit PATH, and StandardOutPath/StandardErrorPath inside the root-owned
// tree rather than the console user's state dir.
private let goldenPlist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.portless.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Library/Application Support/mattstack/proxy/node</string>
    <string>/Library/Application Support/mattstack/proxy/portless-dist/dist/cli.js</string>
    <string>proxy</string>
    <string>start</string>
    <string>--foreground</string>
    <string>--port</string>
    <string>443</string>
    <string>--https</string>
    <string>--skip-trust</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORTLESS_STATE_DIR</key>
    <string>/Users/tester/.portless</string>
    <key>PORTLESS_PORT</key>
    <string>443</string>
    <key>PORTLESS_HTTPS</key>
    <string>1</string>
    <key>PORTLESS_LAN</key>
    <string>0</string>
    <key>PORTLESS_WILDCARD</key>
    <string>0</string>
    <key>HOME</key>
    <string>/Users/tester</string>
    <key>SUDO_UID</key>
    <string>501</string>
    <key>SUDO_GID</key>
    <string>20</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Library/Application Support/mattstack/proxy/log/service.log</string>
  <key>StandardErrorPath</key>
  <string>/Library/Application Support/mattstack/proxy/log/service.log</string>
</dict>
</plist>

"""

extension ConsoleUser {
    static func fixture(
        name: String = "tester",
        home: String = "/Users/tester",
        uid: uid_t = 501,
        gid: gid_t = 20
    ) -> ConsoleUser {
        ConsoleUser(name: name, home: home, uid: uid, gid: gid)
    }
}

final class LaunchdPlistTests: XCTestCase {
    private func render(user: ConsoleUser = .fixture()) -> String {
        LaunchdPlist.render(
            nodePath: ProxyPaths.node,
            cliPath: ProxyPaths.cli,
            stateDir: user.stateDir,
            user: user,
            logPath: ProxyPaths.logFile)
    }

    func testPlistGolden() {
        XCTAssertEqual(render(), goldenPlist)
    }

    func testRenderedPlistParses() throws {
        let parsed = try XCTUnwrap(
            try PropertyListSerialization.propertyList(
                from: Data(render().utf8), options: [], format: nil) as? [String: Any])
        XCTAssertEqual(parsed["Label"] as? String, "sh.portless.proxy")
        XCTAssertEqual(parsed["RunAtLoad"] as? Bool, true)
        XCTAssertEqual(parsed["KeepAlive"] as? Bool, true)
        let argv = try XCTUnwrap(parsed["ProgramArguments"] as? [String])
        XCTAssertEqual(argv.first, ProxyPaths.node)
        XCTAssertEqual(argv[1], ProxyPaths.cli)
        // The daemon-serve verb portless's own service install uses. `start`
        // alone is a different command and would exit immediately.
        XCTAssertEqual(Array(argv.dropFirst(2)), ["proxy", "start", "--foreground", "--port", "443", "--https", "--skip-trust"])
        let env = try XCTUnwrap(parsed["EnvironmentVariables"] as? [String: String])
        XCTAssertEqual(env["PORTLESS_STATE_DIR"], "/Users/tester/.portless")
        // portless chowns what it writes back to SUDO_UID; without these the
        // root daemon leaves root-owned files in the user's own state dir.
        XCTAssertEqual(env["SUDO_UID"], "501")
        XCTAssertEqual(env["SUDO_GID"], "20")
        XCTAssertEqual(env["HOME"], "/Users/tester")
    }

    // A home directory the console user controls is the only attacker-shaped
    // input in the plist: unescaped, it closes the <string> and appends keys.
    func testEscapesConsoleUserSuppliedText() throws {
        let hostile = "/Users/x</string><key>UserName</key><string>nobody</string><string>"
        let plist = render(user: .fixture(name: "x", home: hostile))
        let parsed = try XCTUnwrap(
            try PropertyListSerialization.propertyList(
                from: Data(plist.utf8), options: [], format: nil) as? [String: Any])
        XCTAssertNil(parsed["UserName"])
        let env = try XCTUnwrap(parsed["EnvironmentVariables"] as? [String: String])
        XCTAssertEqual(env["HOME"], hostile)
    }

    func testPathsAreTheCompiledInOnes() {
        XCTAssertEqual(LaunchdPlist.label, "sh.portless.proxy")
        XCTAssertEqual(LaunchdPlist.path, "/Library/LaunchDaemons/sh.portless.proxy.plist")
        // A leading dot keeps the half-written candidate out of launchd's view,
        // and it is a sibling so the rename into place is same-filesystem.
        XCTAssertEqual(LaunchdPlist.stagePath, "/Library/LaunchDaemons/.sh.portless.proxy.plist.stage")
    }
}
