import Foundation
import MattstackCore
import Network
import ServiceManagement

// MARK: - TrayServer

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
    static let socketPath = NSHomeDirectory() + "/.mattstack/rt/tray.sock"

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
    static func exitIfAnotherTrayOwnsSocket() {
        guard FileManager.default.fileExists(atPath: socketPath) else { return }
        guard liveTrayAnswers(atPath: socketPath) else {
            TrayLog.info("stale tray socket found, taking it over", ["socket": socketPath])
            return
        }
        TrayLog.error("another tray owns the socket", ["socket": socketPath])
        // Clean exit — a double-launch is not a crash, and nothing supervises
        // the app. Nothing has been registered at this point.
        exit(0)
    }

    /// CONNECT to the unix socket and require an actual HTTP answer.
    /// Blocking + short-timeout on purpose: this runs on the main thread
    /// before the run loop starts, and must produce a verdict, not a future.
    private static func liveTrayAnswers(atPath path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { return false }
        withUnsafeMutablePointer(to: &addr.sun_path) { raw in
            raw.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                for (i, b) in bytes.enumerated() { dst[i] = CChar(bitPattern: b) }
                dst[bytes.count] = 0
            }
        }

        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let connected = withUnsafePointer(to: &addr) { ptr -> Bool in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
            }
        }
        // ECONNREFUSED here = the file is a leftover with no listener.
        guard connected else { return false }

        let request = "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        let sent = request.withCString { write(fd, $0, strlen($0)) }
        guard sent > 0 else { return false }

        var buf = [UInt8](repeating: 0, count: 256)
        // A bound tray that never answers (wedged) reads 0/-1 on timeout and
        // is treated as dead — better to take the socket than to refuse to
        // start behind a hung process.
        return read(fd, &buf, buf.count) > 0
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

            } else if method == "GET" && path == "/health" {
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true,\"app\":\"mattstack\"}")

            } else if method == "POST" && path == "/daemon/start" {
                DispatchQueue.main.async {
                    self.daemonLifecycle?.startDaemon()
                }
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")

            } else if method == "POST" && path == "/daemon/stop" {
                DispatchQueue.main.async {
                    self.daemonLifecycle?.stopDaemon()
                }
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true}")

            } else if method == "POST" && path == "/daemon/restart" {
                DispatchQueue.main.async {
                    self.daemonLifecycle?.restartDaemon()
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
