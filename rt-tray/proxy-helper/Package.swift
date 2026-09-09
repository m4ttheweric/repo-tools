// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "proxy-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ProxyInstall", path: "Sources/ProxyInstall"),
        .testTarget(name: "ProxyInstallTests", dependencies: ["ProxyInstall"], path: "Tests/ProxyInstallTests"),
    ]
)
