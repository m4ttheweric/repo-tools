import Foundation

public enum GlyphTint: Equatable, Sendable { case green, red, yellow, grey, none }

public enum StatusGlyph {
    /// "progress" is the sentinel the view turns into a small ProgressView.
    public static func symbol(for status: RowStatus) -> String {
        switch status {
        case .ready: return "checkmark.circle.fill"
        case .error, .invalid: return "xmark.circle"
        case .needsYou, .missing: return "exclamationmark.triangle"
        case .skipped: return "circle.dotted"
        case .checking: return "progress"
        }
    }
    public static func tint(for status: RowStatus) -> GlyphTint {
        switch status {
        case .ready: return .green
        case .error, .invalid: return .red
        case .needsYou, .missing: return .yellow
        case .skipped: return .grey
        case .checking: return .none
        }
    }
}
