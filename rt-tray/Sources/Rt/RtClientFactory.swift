import Foundation
import MattstackCore

enum RtClientFactory {
    static func make() -> RtClient? {
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        guard let loc = RtBinaryLocator.resolve(bundlePath: Bundle.main.bundlePath, isDevBuild: BundleFlavor.isDevBuild,
                                                isDebugBuild: debug, environment: ProcessInfo.processInfo.environment,
                                                home: AppHome.current, fileExists: { FileManager.default.isExecutableFile(atPath: $0) })
        else {
            TrayLog.error("no rt binary found for this bundle", ["bundle": Bundle.main.bundlePath])
            return nil
        }
        TrayLog.info("rt resolved", ["path": loc.executable.path, "source": String(describing: loc.source)])
        return RtClient(location: loc, environment: ["RT_APP_SOCKET": TrayServer.socketPath])
    }
}
