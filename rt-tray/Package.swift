// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "rt-tray",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.6"),
    ],
    targets: [
        .target(
            name: "MattstackCore",
            path: "Sources-core"
        ),
        .executableTarget(
            name: "rt-tray",
            dependencies: [
                "MattstackCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources",
            swiftSettings: [
                .define("DEBUG", .when(configuration: .debug)),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("UserNotifications"),
                .linkedFramework("ServiceManagement"),
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
                .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker",
                              "@executable_path/../../artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64"],
                              .when(configuration: .debug)),
            ]
        ),
        .executableTarget(
            name: "rt-daemon-shim",
            path: "Sources-daemon-shim"
        ),
        .target(
            name: "MattstackCoreChecks",
            dependencies: ["MattstackCore"],
            path: "Tests/MattstackCoreChecks"
        ),
        .executableTarget(
            name: "mattstack-checks",
            dependencies: ["MattstackCoreChecks"],
            path: "Tests/mattstack-checks"
        ),
        .testTarget(
            name: "MattstackCoreTests",
            dependencies: ["MattstackCoreChecks"],
            path: "Tests/MattstackCoreTests"
        ),
    ]
)
