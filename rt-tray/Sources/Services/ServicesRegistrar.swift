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
                                          readLabel: ServicePlistScanner.systemReadLabel,
                                          readBundleProgram: ServicePlistScanner.systemReadBundleProgram)
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
            if let missing = ServiceProgramGuard.missingProgramPath(bundleProgram: plist.bundleProgram, bundlePath: bundlePath,
                                                                     exists: { FileManager.default.isExecutableFile(atPath: $0) }) {
                TrayLog.warn("skipping agent register; BundleProgram not in bundle", ["label": plist.label, "program": missing])
                return ServiceRegisterResult(plist: name, ok: false, status: "notFound", error: "BundleProgram missing: \(missing)")
            }
            let svc = service(plist)
            do {
                try svc.register()
                let s = svc.status
                TrayLog.info("agent registered", ["label": plist.label, "status": TrayServer.statusName(s)])
                return ServiceRegisterResult(plist: name, ok: s != .notFound, status: TrayServer.statusName(s))
            } catch {
                let ns = error as NSError
                // Literal, not the SMAppServiceErrorDomain symbol: that constant
                // needs macOS 15, this package targets macOS 14.
                let already = ns.domain == "SMAppServiceErrorDomain" && ns.code == kSMErrorAlreadyRegistered
                let s = svc.status
                let ok = already && s != .notFound
                if !ok { TrayLog.error("agent register failed", ["label": plist.label, "err": String(describing: error)]) }
                return ServiceRegisterResult(plist: name, ok: ok, status: TrayServer.statusName(s),
                                             error: ok ? nil : String(describing: error))
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
                    let s = svc.status
                    TrayLog.info("agent unregistered", ["label": plist.label, "status": TrayServer.statusName(s)])
                    return ServiceRegisterResult(plist: name, ok: s == .notRegistered, status: TrayServer.statusName(s))
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

    func restartAll() async { _ = await restartAllChecked() }

    /// Kickstarts every agent and asks deck to restart its managed apps,
    /// reporting whether every spawn in the sequence succeeded — the signal
    /// `handleVersionChange` gates recording the new version on.
    private func restartAllChecked() async -> Bool {
        var ok = true
        for agent in agents { ok = await restart(label: agent.label) && ok }
        let deck = bundlePath + "/Contents/Helpers/deck"
        guard FileManager.default.isExecutableFile(atPath: deck) else {
            TrayLog.info("deck helper not bundled; skipping managed-app restart")
            return ok
        }
        let (exe, args) = DeckRestart.arguments(deckPath: deck)
        let out = await runner.run(exe, args)
        if !out.ok {
            TrayLog.warn("deck restart --managed failed", ["stderr": out.stderr])
            ok = false
        }
        return ok
    }

    /// Called once per launch. On a version change: re-register (idempotent),
    /// kickstart every agent, ask deck to restart its managed apps. The new
    /// version is recorded only once every register + restart step succeeds —
    /// a partial upgrade must stay unrecorded so the next launch retries it,
    /// never gets silently stuck.
    func handleVersionChange(current: String, store: KeyValueStore) async -> VersionChange {
        let change = VersionChangeDetector.evaluate(current: current, store: store)
        guard case .changed(let from, let to) = change else {
            VersionChangeDetector.record(current: current, store: store)
            return change
        }
        TrayLog.info("app version changed; restarting agents", ["from": from, "to": to])
        let registerResults = await MainActor.run { registerAll() }
        let restarted = await restartAllChecked()
        let failedRegisters = registerResults.filter { !$0.ok }.map(\.plist)
        guard failedRegisters.isEmpty, restarted else {
            TrayLog.warn("version-change restart incomplete; leaving version unrecorded for retry",
                         ["from": from, "to": to, "failedRegisters": failedRegisters, "restarted": restarted])
            return change
        }
        VersionChangeDetector.record(current: current, store: store)
        return change
    }
}

extension UserDefaults: KeyValueStore {
    public func set(_ value: String?, forKey key: String) { self.set(value as Any?, forKey: key) }
}
