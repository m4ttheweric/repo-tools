import Foundation
import ServiceManagement
import MattstackCore

/// Registers every agent plist the bundle ships (spec §8/§9) and restarts
/// them when the app's version changes. Spawns only through CommandRunner.
final class ServicesRegistrar: ServicesProviding, @unchecked Sendable {
    let bundlePath: String
    let agents: [AgentPlist]
    private let runner: CommandRunner
    private let uid: uid_t

    init(bundlePath: String, runner: CommandRunner, uid: uid_t = getuid()) {
        self.bundlePath = bundlePath
        self.runner = runner
        self.uid = uid
        let dir = bundlePath + "/Contents/Library/LaunchAgents"
        agents = ServicePlistScanner.scan(directory: dir, list: ServicePlistScanner.systemList,
                                          readLabel: ServicePlistScanner.systemReadLabel)
    }

    private func service(_ plist: AgentPlist) -> SMAppService { SMAppService.agent(plistName: plist.fileName) }

    func smStatuses() -> [SMAppService.Status] { agents.map { service($0).status } }

    @discardableResult
    func registerAll() -> [ServiceRegisterResult] { registerSync(plists: agents.map(\.fileName)) }

    private func registerSync(plists: [String]) -> [ServiceRegisterResult] {
        plists.map { name in
            guard let plist = agents.first(where: { $0.fileName == name }) else {
                return ServiceRegisterResult(plist: name, ok: false, status: "notFound", error: "not shipped in this bundle")
            }
            let svc = service(plist)
            do {
                try svc.register()
                TrayLog.info("agent registered", ["label": plist.label, "status": TrayServer.statusName(svc.status)])
                return ServiceRegisterResult(plist: name, ok: true, status: TrayServer.statusName(svc.status))
            } catch {
                let already = (error as NSError).code == kSMErrorAlreadyRegistered
                if !already { TrayLog.error("agent register failed", ["label": plist.label, "err": String(describing: error)]) }
                return ServiceRegisterResult(plist: name, ok: already, status: TrayServer.statusName(svc.status),
                                             error: already ? nil : String(describing: error))
            }
        }
    }

    func statuses() async -> [ServiceStatusEntry] {
        agents.map { ServiceStatusEntry(label: $0.label, status: TrayServer.statusName(service($0).status)) }
    }

    func register(plists: [String]) async -> [ServiceRegisterResult] {
        await MainActor.run { registerSync(plists: plists) }
    }

    func unregister(plists: [String]) async -> [ServiceRegisterResult] {
        await MainActor.run {
            plists.map { name in
                guard let plist = agents.first(where: { $0.fileName == name }) else {
                    return ServiceRegisterResult(plist: name, ok: false, status: "notFound", error: "not shipped in this bundle")
                }
                let svc = service(plist)
                do {
                    try svc.unregister()
                    TrayLog.info("agent unregistered", ["label": plist.label])
                    return ServiceRegisterResult(plist: name, ok: true, status: TrayServer.statusName(svc.status))
                } catch {
                    let gone = svc.status == .notRegistered
                    if !gone { TrayLog.error("agent unregister failed", ["label": plist.label, "err": String(describing: error)]) }
                    return ServiceRegisterResult(plist: name, ok: gone, status: TrayServer.statusName(svc.status),
                                                 error: gone ? nil : String(describing: error))
                }
            }
        }
    }

    func restart(label: String) async -> Bool {
        let (exe, args) = Kickstart.arguments(label: label, uid: uid)
        let out = await runner.run(exe, args)
        if !out.ok { TrayLog.warn("kickstart failed", ["label": label, "stderr": out.stderr]) }
        return out.ok
    }

    func restartAll() async {
        for agent in agents { _ = await restart(label: agent.label) }
        let deck = bundlePath + "/Contents/Helpers/deck"
        guard FileManager.default.isExecutableFile(atPath: deck) else {
            TrayLog.info("deck helper not bundled; skipping managed-app restart")
            return
        }
        let (exe, args) = DeckRestart.arguments(deckPath: deck)
        let out = await runner.run(exe, args)
        if !out.ok { TrayLog.warn("deck restart --managed failed", ["stderr": out.stderr]) }
    }

    /// Called once per launch. On a version change: re-register (idempotent),
    /// kickstart every agent, ask deck to restart its managed apps.
    func handleVersionChange(current: String, store: KeyValueStore) async -> VersionChange {
        let change = VersionChangeDetector.evaluate(current: current, store: store)
        if case .changed(let from, let to) = change {
            TrayLog.info("app version changed; restarting agents", ["from": from, "to": to])
            _ = await MainActor.run { registerAll() }
            await restartAll()
        }
        VersionChangeDetector.record(current: current, store: store)
        return change
    }
}

extension UserDefaults: KeyValueStore {
    public func set(_ value: String?, forKey key: String) { self.set(value as Any?, forKey: key) }
}
