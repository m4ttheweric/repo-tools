import Foundation
import MattstackCore

final class FakePerms: PermissionsProviding, @unchecked Sendable {
    var snap = PermissionSnapshot(fda: .init(status: "granted", detail: "probe read ~/Library/Containers/com.apple.stocks"),
                                  notifications: .init(status: "notDetermined"), loginItems: .init(status: "enabled"))
    var requested: [String] = []
    func snapshot() async -> PermissionSnapshot { snap }
    func request(_ which: String) async -> Bool { requested.append(which); return which == "notifications" }
}
final class FakeServices: ServicesProviding, @unchecked Sendable {
    var registered: [[String]] = []
    var unregistered: [[String]] = []
    var restarted: [String] = []
    var registerDelayNs: UInt64 = 0
    func statuses() async -> [ServiceStatusEntry] { [ServiceStatusEntry(label: "com.mattstack.daemon", status: "enabled")] }
    func register(plists: [String]) async -> [ServiceRegisterResult] {
        if registerDelayNs > 0 { try? await Task.sleep(nanoseconds: registerDelayNs) }
        registered.append(plists)
        return plists.map { ServiceRegisterResult(plist: $0, ok: true, status: "enabled") }
    }
    func unregister(plists: [String]) async -> [ServiceRegisterResult] {
        unregistered.append(plists)
        return plists.map { ServiceRegisterResult(plist: $0, ok: true, status: "notRegistered") }
    }
    func restart(label: String) async -> Bool { restarted.append(label); return true }
}
final class FakePrivileged: PrivilegedInstalling, @unchecked Sendable {
    var calls = 0
    var removes = 0
    func proxyInstall() async -> NeedResult { calls += 1; return NeedResult(ok: true, detail: "proxy installed") }
    func proxyRemove() async -> NeedResult { removes += 1; return NeedResult(ok: true, detail: "proxy removed") }
}
final class FakeUpdater: UpdateChecking, @unchecked Sendable { var checks = 0; func checkForUpdates() async -> Bool { checks += 1; return true } }
struct FakeVersion: VersionProviding {
    func versionInfo() -> VersionInfo { VersionInfo(version: "2.8.0", build: 2008000, flavor: "dev", path: "/Applications/mattstack-dev.app") }
}

func makeRoutes() -> (TrayRoutes, FakePerms, FakeServices, FakePrivileged, FakeUpdater, NeedBroker) {
    let p = FakePerms(), s = FakeServices(), pr = FakePrivileged(), u = FakeUpdater()
    let broker = NeedBroker(services: s, privileged: pr)
    return (TrayRoutes(permissions: p, services: s, privileged: pr, needs: broker, updater: u, version: FakeVersion()), p, s, pr, u, broker)
}
func json(_ body: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] ?? [:] }

let trayRoutesChecks: [Check] = [
    Check("GET /permissions returns the contract body") { c in
        let (r, _, _, _, _, _) = makeRoutes()
        let resp = try c.requireSome(await r.handle(method: "GET", path: "/permissions", body: nil))
        c.expectEqual(resp.status, 200)
        let j = json(resp.body)
        c.expectEqual((j["fda"] as? [String: Any])?["status"] as? String, "granted")
        c.expectEqual((j["loginItems"] as? [String: Any])?["status"] as? String, "enabled")
    },
    Check("POST /permissions/request {which} → {ok}") { c in
        let (r, p, _, _, _, _) = makeRoutes()
        let resp = try c.requireSome(await r.handle(method: "POST", path: "/permissions/request", body: Data("{\"which\":\"notifications\"}".utf8)))
        c.expectEqual(resp.status, 200)
        c.expectEqual(json(resp.body)["ok"] as? Bool, true)
        c.expectEqual(p.requested, ["notifications"])
        let bad = await r.handle(method: "POST", path: "/permissions/request", body: Data("{}".utf8))
        c.expectEqual(bad?.status, 400)
    },
    Check("GET /services, POST /services/register, POST /services/restart") { c in
        let (r, _, s, _, _, _) = makeRoutes()
        let list = try c.requireSome(await r.handle(method: "GET", path: "/services", body: nil))
        c.expect(list.body.contains("\"agents\""))
        let reg = try c.requireSome(await r.handle(method: "POST", path: "/services/register", body: Data("{\"plists\":[\"com.mattstack.daemon.plist\"]}".utf8)))
        c.expectEqual(reg.status, 200)
        c.expectEqual(s.registered, [["com.mattstack.daemon.plist"]])
        c.expect(reg.body.contains("\"results\""))
        let rs = await r.handle(method: "POST", path: "/services/restart", body: Data("{\"label\":\"com.mattstack.deck\"}".utf8))
        c.expectEqual(rs?.status, 200)
        c.expectEqual(s.restarted, ["com.mattstack.deck"])
    },
    Check("POST /privileged/proxy-install → NeedResult") { c in
        let (r, _, _, pr, _, _) = makeRoutes()
        let resp = try c.requireSome(await r.handle(method: "POST", path: "/privileged/proxy-install", body: nil))
        c.expectEqual(resp.status, 200)
        c.expectEqual(json(resp.body)["ok"] as? Bool, true)
        c.expectEqual(pr.calls, 1)
    },
    Check("GET /setup/need/<id> serves the app-recorded outcome: pending → done/failed; never a POST") { c in
        let (r, _, s, _, _, broker) = makeRoutes()
        let before = try c.requireSome(await r.handle(method: "GET", path: "/setup/need/services.register", body: nil))
        c.expectEqual(before.status, 200)
        c.expectEqual(json(before.body)["state"] as? String, "pending", "unknown/unstarted id is pending — rt keeps polling")
        let req = NeedRequest(type: "app-register-services", plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"], op: nil)
        _ = await broker.perform(id: "services.register", request: req)
        let after = try c.requireSome(await r.handle(method: "GET", path: "/setup/need/services.register", body: nil))
        let j = json(after.body)
        c.expectEqual(j["state"] as? String, "done")
        c.expect((j["detail"] as? String)?.contains("com.mattstack.daemon.plist") == true)
        c.expectEqual(s.registered.count, 1)
        _ = await broker.perform(id: "x", request: NeedRequest(type: "teleport", plists: nil, op: nil))
        let failed = try c.requireSome(await r.handle(method: "GET", path: "/setup/need/x", body: nil))
        c.expectEqual(json(failed.body)["state"] as? String, "failed")
        let posted = await r.handle(method: "POST", path: "/setup/need/x", body: Data("{}".utf8))
        c.expectEqual(posted?.status, 405, "the contract has no POST reply")
        let empty = await r.handle(method: "GET", path: "/setup/need/", body: nil)
        c.expectEqual(empty?.status, 400)
    },
    Check("NeedBroker: concurrent callers for one id share one execution; outcome is pending while running") { c in
        let s = FakeServices(); s.registerDelayNs = 80_000_000
        let broker = NeedBroker(services: s, privileged: FakePrivileged())
        let req = NeedRequest(type: "app-register-services", plists: ["a.plist"], op: nil)
        async let x = broker.perform(id: "services.register", request: req)
        try await Task.sleep(nanoseconds: 10_000_000)
        c.expectEqual(await broker.outcome(id: "services.register").state, "pending")
        async let y = broker.perform(id: "services.register", request: req)
        let (rx, ry) = await (x, y)
        c.expectEqual(rx, ry)
        c.expectEqual(s.registered.count, 1)
        c.expectEqual(await broker.outcome(id: "services.register").state, "done")
        let privileged = await broker.perform(id: "proxy.install", request: NeedRequest(type: "app-privileged", plists: nil, op: "proxy-install"))
        c.expectEqual(privileged.detail, "proxy installed")
        await broker.forget(id: "proxy.install")
        c.expectEqual(await broker.outcome(id: "proxy.install").state, "pending", "a retry must be able to redo the step")
    },
    Check("NeedBroker: uninstall needs — app-unregister-services and app-privileged/proxy-remove (L1 rt uninstall)") { c in
        let s = FakeServices(), pr = FakePrivileged()
        let broker = NeedBroker(services: s, privileged: pr)
        let un = await broker.perform(id: "services.unregister", request: NeedRequest(type: "app-unregister-services", plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"], op: nil))
        c.expectEqual(un.ok, true)
        c.expectEqual(s.unregistered, [["com.mattstack.daemon.plist", "com.mattstack.deck.plist"]])
        let rm = await broker.perform(id: "proxy.remove", request: NeedRequest(type: "app-privileged", plists: nil, op: "proxy-remove"))
        c.expectEqual(rm.detail, "proxy removed")
        c.expectEqual(pr.removes, 1)
    },
    Check("POST /update/check and GET /version") { c in
        let (r, _, _, _, u, _) = makeRoutes()
        let up = try c.requireSome(await r.handle(method: "POST", path: "/update/check", body: nil))
        c.expectEqual(json(up.body)["ok"] as? Bool, true)
        c.expectEqual(u.checks, 1)
        let v = try c.requireSome(await r.handle(method: "GET", path: "/version", body: nil))
        let j = json(v.body)
        c.expectEqual(j["version"] as? String, "2.8.0")
        c.expectEqual(j["build"] as? Int, 2008000, "build is the numeric CFBundleVersion, never a string")
        c.expectEqual(j["flavor"] as? String, "dev")
        c.expectEqual(j["path"] as? String, "/Applications/mattstack-dev.app")
    },
    Check("unknown paths return nil so the legacy chain handles them") { c in
        let (r, _, _, _, _, _) = makeRoutes()
        let legacy = await r.handle(method: "GET", path: "/health", body: nil)
        c.expect(legacy == nil)
        let wrongMethod = await r.handle(method: "GET", path: "/update/check", body: nil)
        c.expectEqual(wrongMethod?.status, 405)
    },
]
