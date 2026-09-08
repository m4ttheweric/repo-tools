import Foundation

enum Sudoers {
    static let path = "/etc/sudoers.d/mattstack-portless"
    /// sudo skips any file in sudoers.d whose name contains a dot, so the
    /// candidate grants nothing while visudo is still deciding on it.
    static let stagePath = "/etc/sudoers.d/.mattstack-portless.stage"

    /// Exactly the one command deck needs to reload routes on a fresh machine
    /// (the deck-lane contract). `user` must already have passed
    /// `ConsoleUser.isSafeName`: this is sudoers syntax, not a quoted argument.
    static func render(user: String) -> String {
        "\(user) ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/\(LaunchdPlist.label)\n"
    }
}
