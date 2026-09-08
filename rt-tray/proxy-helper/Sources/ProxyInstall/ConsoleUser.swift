import Foundation
import SystemConfiguration

// The one principal an install grants anything to: the human at the GUI session
// who answered the admin prompt. Never `%admin` and never `SUDO_USER` (the
// escalator sets neither), per the spec's sudoers-principal ruling.
struct ConsoleUser: Equatable {
    let name: String
    let home: String
    let uid: uid_t
    let gid: gid_t

    /// The deck-lane contract's state directory: the console user's own
    /// `~/.portless`, which the root daemon reads and writes on their behalf.
    var stateDir: String { URL(fileURLWithPath: home).appendingPathComponent(".portless").path }

    /// The sudoers rule is rendered by interpolation, so a name carrying
    /// sudoers syntax rewrites the rule into something `visudo -c` still
    /// accepts. Only a short-name shape gets through.
    static func isSafeName(_ name: String) -> Bool {
        guard (1...255).contains(name.count), !name.hasPrefix("-") else { return false }
        return name.allSatisfy { ch in
            ch.isASCII && (ch.isLetter || ch.isNumber || ch == "." || ch == "_" || ch == "-")
        }
    }

    static func current() throws -> ConsoleUser {
        var uid: uid_t = 0
        var gid: gid_t = 0
        // "loginwindow" is what the store reports between logins; there is no
        // human to grant anything to then.
        guard let name = SCDynamicStoreCopyConsoleUser(nil, &uid, &gid) as String?,
              !name.isEmpty, name != "loginwindow" else {
            throw ProxyInstallError("nobody is logged in at the console; run Install from a logged-in session")
        }
        guard uid != 0 else {
            throw ProxyInstallError("the console session belongs to root; cannot identify a user to grant")
        }
        guard isSafeName(name) else {
            throw ProxyInstallError("refusing console user name \(name.debugDescription)")
        }
        guard let record = getpwnam(name) else {
            throw ProxyInstallError("no account record for console user \(name)")
        }
        let home = String(cString: record.pointee.pw_dir)
        guard home.hasPrefix("/"), home != "/var/empty" else {
            throw ProxyInstallError("console user \(name) has no usable home directory (\(home))")
        }
        return ConsoleUser(name: name, home: home, uid: uid, gid: gid)
    }
}
