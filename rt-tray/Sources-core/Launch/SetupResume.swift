import Foundation

/// The setup step a relaunched app returns to. A permission such as Full
/// Disk Access only takes effect on the next launch, so the checklist offers
/// a relaunch; without this the re-exec reopened the wizard on Welcome.
public enum SetupResume {
    public static let flag = "--resume-setup"

    private static let names: [SetupStep: String] = [
        .welcome: "welcome", .team: "team", .checklist: "checklist", .install: "install", .done: "done",
    ]

    /// Passthrough arguments with any earlier resume pair removed and, when a
    /// step is given, the new pair appended.
    public static func relaunchArguments(passthrough: [String], resumeAt: SetupStep?) -> [String] {
        var out: [String] = []
        var skipNext = false
        for arg in passthrough {
            if skipNext { skipNext = false; continue }
            if arg == flag { skipNext = true; continue }
            out.append(arg)
        }
        if let resumeAt, let name = names[resumeAt] { out += [flag, name] }
        return out
    }

    public static func step(from arguments: [String]) -> SetupStep? {
        guard let i = arguments.firstIndex(of: flag), i + 1 < arguments.count else { return nil }
        return names.first { $0.value == arguments[i + 1] }?.key
    }
}
