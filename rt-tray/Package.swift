// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "rt-tray",
    platforms: [
        .macOS(.v13)  // Required for SMAppService (Login Items)
    ],
    targets: [
        .executableTarget(
            name: "rt-tray",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
            ]
        ),
    ]
)
