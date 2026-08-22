import Foundation

/// Team pane shows where the repo is, never credentials or the full URL.
public enum RemoteMasker {
    public static func mask(_ remote: String) -> String {
        var s = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        var strippedCredentials = false
        if let at = s.lastIndex(of: "@") {
            s = String(s[s.index(after: at)...])
            strippedCredentials = true
        }
        // scp-like host:path → host/path ; host:port/path → host/path
        if let colon = s.firstIndex(of: ":") {
            let after = s[s.index(after: colon)...]
            let port = after.prefix { $0.isNumber }
            let rest = after.dropFirst(port.count)
            s = String(s[..<colon]) + (rest.hasPrefix("/") ? String(rest) : "/" + rest)
        }
        if s.hasSuffix(".git") { s.removeLast(4) }
        while s.hasSuffix("/") { s.removeLast() }
        if s.contains("/") { return s }
        // A path-less remote (e.g. a bare host, no repo segment) fails the
        // "/" check same as unrecognized input — but once credentials were
        // actually stripped out of it, the fallback must never hand the
        // original string — token included — back to the caller.
        guard strippedCredentials else { return remote }
        return s.isEmpty ? "—" : s
    }
}
