import Foundation

public enum Slug {
    public static func make(_ name: String) -> String {
        let lowered = name.lowercased()
        var out = ""
        var lastDash = true
        for ch in lowered {
            if ch.isLetter || ch.isNumber, ch.isASCII {
                out.append(ch); lastDash = false
            } else if !lastDash {
                out.append("-"); lastDash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }
}
