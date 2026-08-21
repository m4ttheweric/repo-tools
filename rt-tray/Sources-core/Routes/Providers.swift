import Foundation

public protocol PermissionsProviding: Sendable {
    func snapshot() async -> PermissionSnapshot
    func request(_ which: String) async -> Bool
}

public protocol UpdateChecking: Sendable { func checkForUpdates() async -> Bool }
public protocol VersionProviding: Sendable { func versionInfo() -> VersionInfo }
