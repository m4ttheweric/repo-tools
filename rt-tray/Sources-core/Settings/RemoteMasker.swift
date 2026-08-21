import Foundation

/// Team pane shows where the repo is, never credentials or the full URL.
public enum RemoteMasker {
    public static func mask(_ remote: String) -> String {
        var s = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }          // strip scheme
        if let at = s.lastIndex(of: "@") { s = String(s[s.index(after: at)...]) }    // strip user[:token]@
        // scp-like host:path → host/path ; host:port/path → host/path
        if let colon = s.firstIndex(of: ":") {
            let after = s[s.index(after: colon)...]
            let port = after.prefix { $0.isNumber }
            let rest = after.dropFirst(port.count)
            s = String(s[..<colon]) + (rest.hasPrefix("/") ? String(rest) : "/" + rest)
        }
        if s.hasSuffix(".git") { s.removeLast(4) }
        while s.hasSuffix("/") { s.removeLast() }
        return s.contains("/") ? s : remote
    }
}
