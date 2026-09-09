import Foundation

// Parity anchor: buildLaunchdPlist / buildProxyCommand / buildServiceEnv in
// portless's own dist/cli.js (what `portless service install` writes on darwin).
// The argv and the PORTLESS_* / HOME / SUDO_* environment are copied from it, so
// the daemon this writes is the one portless supports. Two things are ours:
// PATH is stated rather than inherited, and the log goes to the root-owned tree
// instead of the console user's state dir (a user-writable log path a root
// daemon opens is a write-anywhere primitive).
enum LaunchdPlist {
    static let label = "sh.portless.proxy"
    static let path = "/Library/LaunchDaemons/sh.portless.proxy.plist"
    /// Sibling of the real path so the rename into place is same-filesystem, and
    /// dot-prefixed so launchd never sees a half-written candidate.
    static let stagePath = "/Library/LaunchDaemons/.sh.portless.proxy.plist.stage"
    /// launchd's own default for system daemons, written out so the daemon's
    /// environment does not depend on that default.
    static let daemonPath = "/usr/bin:/bin:/usr/sbin:/sbin"
    static let proxyPort = "443"

    static func render(
        nodePath: String,
        cliPath: String,
        stateDir: String,
        user: ConsoleUser,
        logPath: String
    ) -> String {
        let argv = [
            nodePath, cliPath, "proxy", "start",
            "--foreground", "--port", proxyPort, "--https", "--skip-trust",
        ]
        let environment: [(String, String)] = [
            ("PORTLESS_STATE_DIR", stateDir),
            ("PORTLESS_PORT", proxyPort),
            ("PORTLESS_HTTPS", "1"),
            ("PORTLESS_LAN", "0"),
            ("PORTLESS_WILDCARD", "0"),
            ("HOME", user.home),
            // portless chowns everything the root daemon writes into the state
            // dir back to this pair; without them the user's own portless CLI
            // can no longer rewrite its own files.
            ("SUDO_UID", String(user.uid)),
            ("SUDO_GID", String(user.gid)),
            ("PATH", daemonPath),
        ]
        let args = argv.map { "    <string>\(xmlEscape($0))</string>" }.joined(separator: "\n")
        let env = environment
            .map { "    <key>\(xmlEscape($0.0))</key>\n    <string>\(xmlEscape($0.1))</string>" }
            .joined(separator: "\n")
        return """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>\(label)</string>
  <key>ProgramArguments</key>
  <array>
\(args)
  </array>
  <key>EnvironmentVariables</key>
  <dict>
\(env)
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>\(xmlEscape(logPath))</string>
  <key>StandardErrorPath</key>
  <string>\(xmlEscape(logPath))</string>
</dict>
</plist>

"""
    }

    /// The console user's name and home reach the plist verbatim, and both are
    /// theirs to choose; unescaped, a home path closes the <string> and appends
    /// keys of the attacker's choosing to a root daemon's definition.
    static func xmlEscape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
}
