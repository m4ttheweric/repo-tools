import Foundation

/// Decide serve-vs-stand-down from the CLI's read-only tuple. Failure means
/// SERVE: a tray that cannot read intent must never dismantle its own
/// registrations on a guess (spec §6).
public enum FlavorGate {
    public enum Action: Equatable {
        case serve
        case standDown(intended: String)
    }

    public static func decide(myFlavorIsDev: Bool, modeReadResult: String?) -> Action {
        guard let raw = modeReadResult,
              let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let intended = obj["intended"] as? [String: Any],
              let mode = intended["mode"] as? String,
              mode == "dev" || mode == "prod"
        else { return .serve }
        let myMode = myFlavorIsDev ? "dev" : "prod"
        return mode == myMode ? .serve : .standDown(intended: mode)
    }
}
