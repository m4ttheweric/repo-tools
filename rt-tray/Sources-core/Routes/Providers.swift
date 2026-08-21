import Foundation

public protocol PermissionsProviding: Sendable {
    func snapshot() async -> PermissionSnapshot
    func request(_ which: String) async -> Bool
}
