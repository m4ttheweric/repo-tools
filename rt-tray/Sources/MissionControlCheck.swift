import Foundation

enum MissionControlCheck {

    /// Returns true when macOS Mission Control is bound to Control+Up Arrow,
    /// which steals a key rt uses for navigation.
    ///
    /// Reads com.apple.symbolichotkeys key 32 (Mission Control).
    /// The system default is enabled — if the key is absent, it's on.
    static func isControlUpBoundToMissionControl() -> Bool {
        guard let prefs = UserDefaults(suiteName: "com.apple.symbolichotkeys"),
              let hotkeys = prefs.dictionary(forKey: "AppleSymbolicHotKeys"),
              let entry = hotkeys["32"] as? [String: Any] else {
            // No override exists — system default is enabled
            return true
        }

        let enabled = entry["enabled"] as? Bool ?? true
        guard enabled else { return false }

        // Verify it's actually bound to Up Arrow (keycode 126).
        // A user could have rebound Mission Control to a different key.
        guard let value = entry["value"] as? [String: Any],
              let params = value["parameters"] as? [Int],
              params.count >= 2 else {
            return enabled
        }

        let virtualKeycode = params[1]
        let upArrow = 126
        return virtualKeycode == upArrow
    }

    /// Whether we've already shown the keyboard-conflict notification this install.
    static var hasShownNotification: Bool {
        get { UserDefaults.standard.bool(forKey: "rt.missionControlWarningShown") }
        set { UserDefaults.standard.set(newValue, forKey: "rt.missionControlWarningShown") }
    }
}
