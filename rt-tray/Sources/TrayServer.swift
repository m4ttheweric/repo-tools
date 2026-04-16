import Foundation
import Network

// MARK: - TrayServer

/// Small HTTP server on ~/.rt/tray.sock that receives push notifications from the daemon.
/// The daemon POSTs to /notify with a NotificationEvent JSON body.
class TrayServer {

    static let shared = TrayServer()

    var onNotification: ((NotificationEvent) -> Void)?
    var daemonLifecycle: DaemonLifecycle?

    private var listener: NWListener?
    private let socketPath: String
    private let queue = DispatchQueue(label: "com.rt.tray-server", qos: .userInitiated)

    private init() {
        socketPath = NSHomeDirectory() + "/.rt/tray.sock"
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
            listener?.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    NSLog("rt-tray: server listening on \(self.socketPath)")
                case .failed(let error):
                    NSLog("rt-tray: server failed: \(error)")
                default:
                    break
                }
            }
            listener?.start(queue: queue)
        } catch {
            NSLog("rt-tray: failed to start tray server: \(error)")
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
                self.sendResponse(connection: connection, status: 400, body: "{\"ok\":false,\"error\":\"invalid body\"}")

            } else if method == "GET" && path == "/health" {
                self.sendResponse(connection: connection, status: 200, body: "{\"ok\":true,\"app\":\"rt-tray\"}")

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

            } else {
                self.sendResponse(connection: connection, status: 404, body: "{\"ok\":false,\"error\":\"not found\"}")
            }
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

    private func sendResponse(connection: NWConnection, status: Int, body: String) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 404: statusText = "Not Found"
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
