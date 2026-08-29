import AppKit
import Foundation
import MattstackCore
import Network
import ServiceManagement

// MARK: - TrayServer

/// Body of the daemon's POST /pane/focus (its pane:focus verb).
private struct FocusPaneRequest: Decodable { let paneId: String }

/// Small HTTP server on ~/.mattstack/rt/tray.sock that receives push notifications from the daemon.
/// The daemon POSTs to /notify with a NotificationEvent JSON body.
class TrayServer {

    static let shared = TrayServer()

    var onNotification: ((NotificationEvent) -> Void)?
    var daemonLifecycle: DaemonLifecycle?
    var routes: TrayRoutes?

    private var listener: NWListener?
    private let socketPath: String
    private let queue = DispatchQueue(label: "com.rt.tray-server", qos: .userInitiated)

    private init() {
        socketPath = Self.socketPath
    }

    /// The one socket both flavors bind. Static so the startup guard can
    /// probe it before any TrayServer instance exists.
    static let socketPath = AppHome.current + "/.mattstack/rt/tray.sock"

    // MARK: - Startup mutual exclusion

    /// Exit if a live tray already owns the socket (spec MAT-383 §3).
    ///
    /// `start()` unlinks and rebinds blindly, so without this the
    /// last-launched tray silently steals every `rt daemon *` command from
    /// the running one. Both flavors bind the same path, so a mis-ordered
    /// dev-mode toggle — or a plain double-launch — would leave two trays
    /// with two registered daemon agents fighting over rt.pid.
    ///
    /// **Call this before ANY SMAppService registration.** An app that exits
    /// here must not have registered a daemon agent or a login item on its
    /// way out, or the loser's registrations outlive it. That's why the call
    /// site is `main.swift`, ahead of the AppDelegate.
    ///
    /// A leaked socket file (pkill'd tray) is not a live tray: the probe is a
    /// CONNECT + request/response, never a file-existence check.
    ///
    /// Only ever called on the serving path — a tray the flavor gate has stood
    /// down never binds and never evicts anyone (`main.swift`).
    static func exitIfAnotherTrayOwnsSocket() {
        switch claimSocket() {
        case .claimed:
            return
        case .heldByPeer:
            // Clean exit — a double-launch is not a crash, and nothing
            // supervises the app. Nothing has been registered at this point.
            exit(0)
        case .heldByStuckHolder(let holderFlavor):
            // The retire already landed, so only the intended flavor's
            // registrations remain: the machine converges on its own at the
            // next login, when the zombie is gone and this app launches into
            // a free socket. Until then nothing is serving, which the user
            // has to be told rather than left to discover.
            StandDownNotice.postBlocking(
                title: FlavorStandDownCopy.stuckHolderTitle(holderFlavor: holderFlavor),
                body: FlavorStandDownCopy.stuckHolderBody(
                    holderFlavor: holderFlavor,
                    myFlavor: FlavorIdentity.flavorName(isDevBuild: BundleFlavor.isDevBuild)),
                identifier: "mattstack-flavor-stuck-holder")
            exit(0)
        }
    }

    enum SocketClaim: Equatable {
        case claimed
        case heldByPeer(flavor: String)
        /// A wrong-flavor holder that would not give the socket up.
        case heldByStuckHolder(flavor: String)
    }

    /// The guard's verdict without the exit, so a caller that is already
    /// running (the mismatch alert's switch) can report the failure instead of
    /// vanishing mid-launch.
    static func claimSocket() -> SocketClaim {
        guard FileManager.default.fileExists(atPath: socketPath) else { return .claimed }
        let answer = probeTray(atPath: socketPath)
        let myFlavor = FlavorIdentity.flavorName(isDevBuild: BundleFlavor.isDevBuild)
        let holderFlavor = answer.flatMap(TrayHealth.flavor(inResponse:))
        switch SocketOwnership.decide(myFlavor: myFlavor, holderIsLive: answer != nil, holderFlavor: holderFlavor,
                                      intentConfirmed: FlavorGateState.intentConfirmed) {
        case .takeOver:
            TrayLog.info("stale tray socket found, taking it over", ["socket": socketPath])
            return .claimed
        case .standAside:
            TrayLog.error("another tray owns the socket", ["socket": socketPath, "holder": holderFlavor ?? "unknown"])
            return .heldByPeer(flavor: holderFlavor ?? "unknown")
        case .evictThenTakeOver:
            return evictHolder(holderFlavor: holderFlavor ?? "unknown", myFlavor: myFlavor)
        }
    }

    /// The socket is held by the flavor this machine is no longer set to.
    ///
    /// `/flavor/retire` makes the holder give up its registrations but not its
    /// listener — only quitting frees the socket — so eviction is retire, then
    /// quit, then a bounded wait for the socket to actually go quiet. The
    /// order is forced: retire has to reach a holder that is still alive.
    private static func evictHolder(holderFlavor: String, myFlavor: String) -> SocketClaim {
        TrayLog.info("wrong-flavor tray holds the socket; evicting",
                     ["holder": holderFlavor, "flavor": myFlavor])
        switch request("POST", "/flavor/retire", atPath: socketPath, timeoutSeconds: 5) {
        case .none:
            TrayLog.warn("holder did not answer /flavor/retire", ["holder": holderFlavor])
        case .some(let reply) where HTTPReply.succeeded(reply):
            TrayLog.info("holder retired its registrations", ["reply": HTTPReply.parse(reply)?.body ?? ""])
        case .some(let reply):
            // A tray without the route 404s here and keeps both of its
            // registrations, so quitting it is all this eviction achieves.
            TrayLog.warn("holder refused to retire",
                         ["holder": holderFlavor, "status": HTTPReply.parse(reply)?.status ?? 0])
        }
        quitSiblingFlavor()

        for _ in 0..<10 {
            Thread.sleep(forTimeInterval: 0.5)
            guard probeTray(atPath: socketPath) != nil else {
                TrayLog.info("wrong-flavor tray released the socket", ["holder": holderFlavor])
                return .claimed
            }
        }
        TrayLog.error("wrong-flavor tray still owns the socket",
                      ["holder": holderFlavor, "socket": socketPath])
        return .heldByStuckHolder(flavor: holderFlavor)
    }

    /// Ask the other flavor's app to quit. `terminate()` is a quit Apple Event,
    /// so the holder runs its own `applicationWillTerminate` and takes its
    /// socket file with it.
    private static func quitSiblingFlavor() {
        guard let mine = Bundle.main.bundleIdentifier else { return }
        let sibling = FlavorIdentity.sibling(ofBundleID: mine)
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: sibling)
        guard !running.isEmpty else {
            TrayLog.warn("no running app to quit for the holder", ["bundleId": sibling])
            return
        }
        for app in running { _ = app.terminate() }
        TrayLog.info("asked the other flavor to quit", ["bundleId": sibling, "count": running.count])
    }

    /// CONNECT to the unix socket and require an actual HTTP answer, returned
    /// raw so the caller can read the holder's flavor out of it.
    private static func probeTray(atPath path: String) -> String? {
        request("GET", "/health", atPath: path, timeoutSeconds: 1)
    }

    /// One blocking request/response on the tray socket. Blocking +
    /// short-timeout on purpose: this runs on the main thread before the run
    /// loop starts, and must produce a verdict, not a future.
    private static func request(_ method: String, _ route: String, atPath path: String, timeoutSeconds: Int) -> String? {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { raw in
            raw.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                for (i, b) in bytes.enumerated() { dst[i] = CChar(bitPattern: b) }
                dst[bytes.count] = 0
            }
        }

        var tv = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let connected = withUnsafePointer(to: &addr) { ptr -> Bool in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
            }
        }
        // ECONNREFUSED here = the file is a leftover with no listener.
        guard connected else { return nil }

        let wire = "\(method) \(route) HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        let sent = wire.withCString { write(fd, $0, strlen($0)) }
        guard sent > 0 else { return nil }

        // Read to the server's close (every reply sets Connection: close) so
        // the body is never truncated mid-JSON.
        var response = Data()
        var buf = [UInt8](repeating: 0, count: 1024)
        while response.count < 8192 {
            let n = read(fd, &buf, buf.count)
            guard n > 0 else { break }
            response.append(contentsOf: buf[0..<n])
        }
        // A bound tray that never answers (wedged) reads 0/-1 on timeout and
        // is treated as dead — better to take the socket than to refuse to
        // start behind a hung process.
        guard !response.isEmpty else { return nil }
        return String(decoding: response, as: UTF8.self)
    }

    // MARK: - Start / Stop

    func start() {
        // Clean up stale socket
        if FileManager.default.fileExists(atPath: socketPath) {
            try? FileManager.default.removeItem(atPath: socketPath)
        }

        do {
            let params = NWParameters()
            params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
            params.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)

            listener = try NWListener(using: params)
            listener?.newConnectionHandler = { [weak self] connection in
                self?.handleConnection(connection)
            }
            listener?.stateUpdateHandler = { [socketPath] state in
                switch state {
                case .ready:
                    TrayLog.info("server listening on \(socketPath)")
                case .failed(let error):
                    TrayLog.error("server failed", ["err": String(describing: error)])
                default:
                    break
                }
            }
            listener?.start(queue: queue)
        } catch {
            TrayLog.error("failed to start tray server", ["err": String(describing: error)])
        }
    }

    func stop() {
        // Only a tray that actually bound may unlink the path. A tray that
        // quits without ever serving — a flavor stand-down, a translocated
        // copy — would otherwise delete the socket file out from under the
        // tray that IS serving, leaving it bound to a path nothing can reach.
        guard listener != nil else { return }
        listener?.cancel()
        listener = nil
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)

        // Read the full request
        readFullRequest(connection: connection) { [weak self] data in
            guard let self = self, let data = data else {
                self?.sendResponse(connection: connection, status: 400, body: "{\"ok\":false}")
                return
            }

            // Parse HTTP request
            guard let str = String(data: data, encoding: .utf8) else {
                self.sendResponse(connection: connection, status: 400, body: "{\"ok\":false}")
                return
            }

            // Extract path and body
            let lines = str.components(separatedBy: "\r\n")
            guard let requestLine = lines.first else {
                self.sendResponse(connection: connection, status: 400, body: "{\"ok\":false}")
                return
            }

            let parts = requestLine.components(separatedBy: " ")
            let method = parts.first ?? ""
            let path = parts.count > 1 ? parts[1] : ""

            let bodyData: Data? = str.range(of: "\r\n\r\n").map { Data(String(str[$0.upperBound...]).utf8) }
            if let routes = self.routes {
                Task {
                    if let reply = await routes.handle(method: method, path: path, body: bodyData) {
                        self.sendResponse(connection: connection, status: reply.status, body: reply.body, path: path)
                    } else {
                        self.handleLegacy(method: method, path: path, str: str, connection: connection)
                    }
                }
                return
            }
            self.handleLegacy(method: method, path: path, str: str, connection: connection)
        }
    }

    private func handleLegacy(method: String, path: String, str: String, connection: NWConnection) {
            if method == "POST" && path == "/notify" {
                // Extract JSON body (after blank line)
                if let bodyRange = str.range(of: "\r\n\r\n") {
                    let bodyStr = String(str[bodyRange.upperBound...])
                    if let bodyData = bodyStr.data(using: .utf8),
                       let event = try? JSONDecoder().decode(NotificationEvent.self, from: bodyData) {

                        // Dispatch notification on main thread
                        DispatchQueue.main.async {
                            self.onNotification?(event)
                        }

                        self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")
                        return
                    }
                }
                self.sendResponse(connection: connection, status: 400, body: "{\"ok\":false,\"error\":\"invalid body\"}", path: path)

            } else if method == "POST" && path == "/pane/focus" {
                // The rt daemon's pane:focus verb routes here: the tray owns
                // the herdr focus + the native terminal-window raise. Runs on
                // the connection queue (herdr shell-outs block briefly), same
                // as /flavor/retire's synchronous work.
                if let bodyRange = str.range(of: "\r\n\r\n"),
                   let bodyData = String(str[bodyRange.upperBound...]).data(using: .utf8),
                   let req = try? JSONDecoder().decode(FocusPaneRequest.self, from: bodyData) {
                    switch HerdrBridge.shared.focusPaneById(req.paneId) {
                    case .focused:
                        self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true,\"focused\":true}")
                    case .notFound:
                        self.sendResponse(connection: connection, status: 404, body: "{\"ok\":false,\"error\":\"pane not found\"}", path: path)
                    case .herdrUnavailable:
                        self.sendResponse(connection: connection, status: 500, body: "{\"ok\":false,\"error\":\"herdr unavailable\"}", path: path)
                    }
                } else {
                    self.sendResponse(connection: connection, status: 400, body: "{\"ok\":false,\"error\":\"invalid body\"}", path: path)
                }

            } else if method == "GET" && path == "/health" {
                // The flavor field is what lets a starting tray tell a sibling
                // holder from a same-flavor double-launch.
                self.sendResponse(connection: connection, status: 200,
                                  body: TrayHealth.body(isDevBuild: BundleFlavor.isDevBuild))

            } else if method == "POST" && path == "/daemon/start" {
                DispatchQueue.main.async {
                    Task { await self.daemonLifecycle?.startDaemon() }
                }
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")

            } else if method == "POST" && path == "/daemon/stop" {
                DispatchQueue.main.async {
                    self.daemonLifecycle?.stopDaemon()
                }
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")

            } else if method == "POST" && path == "/daemon/restart" {
                DispatchQueue.main.async {
                    Task { await self.daemonLifecycle?.restartDaemon() }
                }
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")

            } else if method == "POST" && path == "/flavor/retire" {
                // Flavor handoff (spec MAT-383 §3). `rt settings dev-mode
                // on|off` calls this on the OUTGOING tray before quitting it:
                // this app gives up both of its registrations — its own
                // daemon LaunchAgent (its MSDaemonLabel job) and its own
                // login item — so the incoming flavor is the only registered
                // pair. Without it two agents stay registered and their
                // daemons fight over rt.pid/rt.sock.
                //
                // Replaces the deleted login-item reset route (the LWCR
                // re-register dance), which existed only for the in-place
                // binary swaps that no longer happen.
                //
                // Runs synchronously on main so the reply reflects the
                // actual post-state, not an intention.
                var errs: [String] = []
                var daemonAfter = "unknown"
                var loginAfter = "unknown"
                DispatchQueue.main.sync {
                    if let lifecycle = self.daemonLifecycle {
                        lifecycle.stopDaemon()   // service.unregister(), logs itself
                        daemonAfter = Self.statusName(lifecycle.status)
                    } else {
                        errs.append("no daemonLifecycle wired")
                    }
                    do {
                        try SMAppService.mainApp.unregister()
                    } catch {
                        // Unregistering an already-unregistered login item
                        // throws; the status check below is the ground truth.
                        TrayLog.warn("mainApp.unregister failed", ["err": String(describing: error)])
                        errs.append(String(describing: error))
                    }
                    loginAfter = Self.statusName(SMAppService.mainApp.status)
                }

                // Ground truth, not intention: retired means neither
                // registration is enabled any more.
                let retired = daemonAfter != "enabled" && loginAfter != "enabled"
                if retired {
                    TrayLog.info("flavor retired",
                                 ["daemon": daemonAfter, "loginItem": loginAfter,
                                  "label": self.daemonLifecycle?.label ?? "(none)"])
                    self.sendResponse(connection: connection, status: 200,
                                      body: "{\"ok\":true,\"daemon\":\"\(daemonAfter)\",\"loginItem\":\"\(loginAfter)\"}")
                } else {
                    let errMsg = errs.joined(separator: "; ")
                        .replacingOccurrences(of: "\"", with: "\\\"")
                    TrayLog.error("flavor retire failed",
                                  ["daemon": daemonAfter, "loginItem": loginAfter, "err": errMsg])
                    self.sendResponse(connection: connection, status: 500,
                                      body: "{\"ok\":false,\"daemon\":\"\(daemonAfter)\",\"loginItem\":\"\(loginAfter)\",\"error\":\"\(errMsg)\"}",
                                      path: path)
                }

            } else if method == "GET" && path == "/daemon/status" {
                let statusStr = self.daemonLifecycle.map { Self.statusName($0.status) } ?? "unknown"
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true,\"status\":\"\(statusStr)\"}")

            } else {
                self.sendResponse(connection: connection, status: 404, body: "{\"ok\":false,\"error\":\"not found\"}", path: path)
            }
    }

    private func readFullRequest(connection: NWConnection, buffer: Data = Data(), completion: @escaping (Data?) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { content, _, isComplete, error in
            var accumulated = buffer
            if let content = content {
                accumulated.append(content)
            }

            // Check if we have the full request (contains \r\n\r\n and body)
            if let str = String(data: accumulated, encoding: .utf8) {
                if str.contains("\r\n\r\n") {
                    // For POST, check Content-Length to know if we have the full body
                    let headers = str.components(separatedBy: "\r\n\r\n").first ?? ""
                    if let clRange = headers.range(of: "Content-Length: ", options: .caseInsensitive) {
                        let rest = String(headers[clRange.upperBound...])
                        let clStr = rest.components(separatedBy: "\r\n").first ?? "0"
                        if let contentLength = Int(clStr) {
                            let bodyStart = str.range(of: "\r\n\r\n")!.upperBound
                            let bodyLength = str[bodyStart...].utf8.count
                            if bodyLength >= contentLength {
                                completion(accumulated)
                                return
                            }
                        }
                    } else {
                        // GET request or no Content-Length — we have everything
                        completion(accumulated)
                        return
                    }
                }
            }

            if isComplete || error != nil {
                completion(accumulated.isEmpty ? nil : accumulated)
            } else {
                self.readFullRequest(connection: connection, buffer: accumulated, completion: completion)
            }
        }
    }

    static func statusName(_ status: SMAppService.Status) -> String {
        switch status {
        case .enabled:          return "enabled"
        case .requiresApproval: return "requiresApproval"
        case .notRegistered:    return "notRegistered"
        case .notFound:         return "notFound"
        @unknown default:       return "unknown"
        }
    }

    private func sendResponse(connection: NWConnection, status: Int, body: String, path: String? = nil) {
        // Central error-visibility seam: every non-2xx reply from any route,
        // present or future, leaves a trace.
        if status >= 400 {
            TrayLog.warn("request failed", ["status": status, "path": path ?? "(unparsed)", "body": body])
        }
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
        case 405: statusText = "Method Not Allowed"
        case 500: statusText = "Error"
        default: statusText = "Error"
        }

        let response = """
        HTTP/1.1 \(status) \(statusText)\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """

        if let data = response.data(using: .utf8) {
            connection.send(content: data, completion: .contentProcessed { _ in
                connection.cancel()
            })
        } else {
            connection.cancel()
        }
    }
}
