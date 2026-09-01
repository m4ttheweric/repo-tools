// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "rt-tray",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        // Local artifact from deps.lock (scripts/fetch-deps.sh arm64): SPM's own
        // download of this zip hangs indefinitely on GitHub-hosted macOS runners,
        // so the remote package dependency is deliberately gone.
        .binaryTarget(
            name: "Sparkle",
            path: "deps/tools/sparkle-xcframework/Sparkle.xcframework"
        ),
        .target(
            name: "MattstackCore",
            path: "Sources-core"
        ),
        .executableTarget(
            name: "rt-tray",
            dependencies: [
                "MattstackCore",
                "Sparkle",
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
                              "@executable_path/../../../deps/tools/sparkle-xcframework/Sparkle.xcframework/macos-arm64_x86_64"],
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
