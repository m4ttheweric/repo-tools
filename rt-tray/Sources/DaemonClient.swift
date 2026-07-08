import Foundation
import Network

// MARK: - DaemonClient

/// Communicates with the rt daemon via HTTP over Unix domain socket (~/.rt/rt.sock).
class DaemonClient {

    private let socketPath: String

    init(socketPath: String? = nil) {
        self.socketPath = socketPath ?? NSHomeDirectory() + "/.rt/rt.sock"
    }

    // MARK: - Public API

    func isReachable() async -> Bool {
        guard let response: PingResponse = await query("ping") else { return false }
        return response.ok
    }

    func queryTrayStatus() async -> DaemonStatus? {
        guard let response: TrayStatusResponse = await query("tray:status") else { return nil }
        guard response.ok, let data = response.data else { return nil }
        return DaemonStatus(
            pid: data.pid,
            uptime: data.uptime,
            memoryUsage: data.memoryUsage,
            watchedRepos: data.watchedRepos,
            cacheEntries: data.cacheEntries,
            portsCached: data.portsCached,
            portsByRepo: data.portsByRepo,
            pendingNotifications: data.pendingNotifications,
            lastRefresh: data.lastRefresh
        )
    }

    func fetchNotifications() async -> [NotificationEvent]? {
        guard let response: NotificationsResponse = await query("notifications") else { return nil }
        guard response.ok else { return nil }
        return response.data
    }

    func querySystemProcesses() async -> SystemProcessData? {
        guard let response: SystemProcessResponse = await query("system-processes") else { return nil }
        return response.ok ? response.data : nil
    }

    // MARK: - Query (HTTP API with Unix socket fallback)

    /// Query the daemon. Tries the HTTP API on :9401 first (reliable, uses
    /// URLSession), falls back to the Unix socket if the TCP port is unreachable.
    private func query<T: Decodable>(_ command: String) async -> T? {
        // Primary: HTTP API on localhost:9401 (URLSession, robust)
        if let result: T = await queryHTTP(command) {
            return result
        }
        // Fallback: Unix socket (NWConnection, can get stuck)
        return await querySocket(command)
    }

    private static let apiPort = 9401

    /// HTTP GET via URLSession to localhost:9401. Fast, reliable, no NWConnection issues.
    private func queryHTTP<T: Decodable>(_ command: String) async -> T? {
        let path: String
        switch command {
        case "tray:status": path = "/api/status"
        case "ping":        path = "/api/status"
        case "notifications": path = "/api/notifications"
        case "system-processes": path = "/api/processes/system"
        default:            path = "/api/\(command)"
        }

        guard let url = URL(string: "http://127.0.0.1:\(Self.apiPort)\(path)") else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                let preview = String(data: data.prefix(500), encoding: .utf8) ?? "<binary>"
                TrayLog.error("decode \(command) failed", ["err": String(describing: error), "preview": preview])
                return nil
            }
        } catch {
            return nil
        }
    }

    /// Fallback: HTTP over Unix socket via NWConnection.
    private func querySocket<T: Decodable>(_ command: String) async -> T? {
        guard FileManager.default.fileExists(atPath: socketPath) else { return nil }

        return await withCheckedContinuation { continuation in
            let endpoint = NWEndpoint.unix(path: socketPath)
            let params = NWParameters()
            params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
            let connection = NWConnection(to: endpoint, using: params)

            let guard_q = DispatchQueue(label: "rt.query.\(command)")
            var completed = false
            var hasReachedReady = false
            let complete: (T?) -> Void = { result in
                guard_q.sync {
                    guard !completed else { return }
                    completed = true
                    connection.cancel()
                    continuation.resume(returning: result)
                }
            }

            DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
                complete(nil)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard_q.sync { hasReachedReady = true }
                    let request = "GET /\(command) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                    guard let data = request.data(using: .utf8) else {
                        complete(nil)
                        return
                    }
                    connection.send(content: data, completion: .contentProcessed { error in
                        if error != nil {
                            complete(nil)
                            return
                        }
                        self.readFullResponse(connection: connection) { responseData in
                            guard let responseData = responseData,
                                  let jsonBody = self.extractJSONBody(from: responseData) else {
                                complete(nil)
                                return
                            }
                            do {
                                let decoded = try JSONDecoder().decode(T.self, from: jsonBody)
                                complete(decoded)
                            } catch {
                                complete(nil)
                            }
                        }
                    })

                case .failed:
                    let wasReady = guard_q.sync { hasReachedReady }
                    if !wasReady {
                        complete(nil)
                    }

                case .cancelled:
                    break

                default:
                    break
                }
            }

            connection.start(queue: .global())
        }
    }

    /// Read the full HTTP response (handles chunked reads).
    private func readFullResponse(connection: NWConnection, buffer: Data = Data(), completion: @escaping (Data?) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { content, _, isComplete, error in
            var accumulated = buffer
            if let content = content {
                accumulated.append(content)
            }
            if isComplete {
                completion(accumulated.isEmpty ? nil : accumulated)
            } else if error != nil {
                completion(accumulated.isEmpty ? nil : accumulated)
            } else {
                self.readFullResponse(connection: connection, buffer: accumulated, completion: completion)
            }
        }
    }

    /// Extract the JSON body from an HTTP response (skip headers).
    private func extractJSONBody(from data: Data) -> Data? {
        guard let str = String(data: data, encoding: .utf8) else { return nil }
        if let range = str.range(of: "\r\n\r\n") {
            let body = String(str[range.upperBound...])
            return body.data(using: .utf8)
        }
        if let jsonStart = str.firstIndex(of: "{") {
            let body = String(str[jsonStart...])
            return body.data(using: .utf8)
        }
        return nil
    }
}

// MARK: - Response Types

struct PingResponse: Decodable {
    let ok: Bool
    let uptime: Int?
    let pid: Int?
}

struct TrayStatusResponse: Decodable {
    let ok: Bool
    let data: TrayStatusData?
}

struct TrayStatusData: Decodable {
    let pid: Int
    let uptime: Int
    let memoryUsage: Int
    let watchedRepos: Int
    let cacheEntries: Int
    let portsCached: Int
    let portsByRepo: [String: Int]
    let pendingNotifications: Int
    let lastRefresh: Int?
}

struct NotificationsResponse: Decodable {
    let ok: Bool
    let data: [NotificationEvent]?
}

// MARK: - Notification Event (shared type with daemon)

struct NotificationEvent: Decodable {
    let id: String
    let title: String
    let message: String
    let url: String?
    let category: String
    let timestamp: Int
    // Offending process pids for categories that offer a Kill action
    let pids: [Int]?
}
