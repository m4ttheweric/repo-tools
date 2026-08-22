#if DEBUG
import Foundation
import MattstackCore

/// Stand-ins for the setup flow's "register services" / "install proxy"
/// needs when the app is driven by the stub `rt` (BundleFlavor.isStubActive).
/// Compiled only into DEBUG builds, and only reached once that flag is true,
/// so a real run never touches SMAppService or the admin-authorization
/// escalator through this path.
struct StubServicesProvider: ServicesProviding {
    func statuses() async -> [ServiceStatusEntry] { [] }
    func register(plists: [String]) async -> [ServiceRegisterResult] {
        plists.map { ServiceRegisterResult(plist: $0, ok: true, status: "stubbed") }
    }
    func unregister(plists: [String]) async -> [ServiceRegisterResult] {
        plists.map { ServiceRegisterResult(plist: $0, ok: true, status: "stubbed") }
    }
    func restart(label: String) async -> Bool { true }
}

struct StubPrivilegedInstaller: PrivilegedInstalling {
    func proxyInstall() async -> NeedResult { NeedResult(ok: true, detail: "stubbed") }
    func proxyRemove() async -> NeedResult { NeedResult(ok: true, detail: "stubbed") }
}

/// Replaces the real OS permission probe under stub mode: the real one reads
/// this machine's actual FDA/login-item state (denied, since stub runs use a
/// throwaway HOME) and would permanently veto canInstall. Tracks the
/// perm-denied-then-granted scenario the same way stub.ts's plan() does — off
/// the same RT_STUB_STATE_DIR/plan-calls counter `setup plan --json` bumps on
/// every call — so the local overlay and rt's own plan agree on when FDA
/// flips from denied to granted instead of racing each other.
struct StubPermissionProbe: PermissionProbing {
    private let scenario: String
    private let stateDir: String?

    init() {
        let env = ProcessInfo.processInfo.environment
        scenario = env["RT_STUB_SCENARIO"] ?? ""
        stateDir = env["RT_STUB_STATE_DIR"]
    }

    var fdaNeedsRelaunch: Bool { false }

    func snapshot() async -> PermissionSnapshot {
        let granted = scenario != "perm-denied-then-granted" || planCalls() >= 3
        return PermissionSnapshot(
            fda: .init(status: granted ? "granted" : "denied", detail: granted ? "stub: granted" : "stub: not granted"),
            notifications: .init(status: "notDetermined"),
            loginItems: .init(status: "enabled"))
    }

    private func planCalls() -> Int {
        guard let stateDir,
              let data = FileManager.default.contents(atPath: stateDir + "/plan-calls"),
              let n = Int(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        else { return 0 }
        return n
    }
}
#endif
