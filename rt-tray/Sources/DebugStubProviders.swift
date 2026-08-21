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
#endif
