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

    func sendShutdown() async {
        let _: SimpleResponse? = await query("shutdown")
    }

    func sendCommand(_ cmd: String) async -> Bool {
        guard let response: SimpleResponse = await query(cmd) else { return false }
        return response.ok
    }

    // MARK: - HTTP over Unix Socket

    /// Perform an HTTP GET request over the daemon's Unix socket.
    /// Uses raw TCP via Network.framework since URLSession doesn't support UDS.
    private func query<T: Decodable>(_ command: String) async -> T? {
        guard FileManager.default.fileExists(atPath: socketPath) else { return nil }

        return await withCheckedContinuation { continuation in
            let endpoint = NWEndpoint.unix(path: socketPath)
            let params = NWParameters()
            params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
            let connection = NWConnection(to: endpoint, using: params)

            var completed = false
            var hasReachedReady = false
            let complete: (T?) -> Void = { result in
                guard !completed else { return }
                completed = true
                connection.cancel()
                continuation.resume(returning: result)
            }

            // Timeout after 2 seconds
            DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
                complete(nil)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    hasReachedReady = true
                    // Send HTTP GET request
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
                        // Read response
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
                                NSLog("rt-tray: JSON decode error for /\(command): \(error)")
                                complete(nil)
                            }
                        }
                    })

                case .failed:
                    // Only treat as error if we never reached .ready.
                    // After .ready, the server's "Connection: close" fires .failed
                    // (POSIX error 50) but the response data is already buffered
                    // and will be delivered via readFullResponse.
                    if !hasReachedReady {
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
                // Server closed connection (normal for Connection: close)
                completion(accumulated.isEmpty ? nil : accumulated)
            } else if error != nil {
                // Connection error — return whatever we have
                completion(accumulated.isEmpty ? nil : accumulated)
            } else {
                // Keep reading
                self.readFullResponse(connection: connection, buffer: accumulated, completion: completion)
            }
        }
    }

    /// Extract the JSON body from an HTTP response (skip headers).
    private func extractJSONBody(from data: Data) -> Data? {
        guard let str = String(data: data, encoding: .utf8) else { return nil }

        // Find the blank line separating headers from body
        if let range = str.range(of: "\r\n\r\n") {
            let body = String(str[range.upperBound...])
            return body.data(using: .utf8)
        }

        // Fallback: try to find JSON directly
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

struct SimpleResponse: Decodable {
    let ok: Bool
    let message: String?
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
}
