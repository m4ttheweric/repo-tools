import Foundation

enum Op: Equatable { case version, install, remove, trust, usage }

enum ProxyInstallMain {
    static func parse(argv: [String]) -> Op {
        switch argv.dropFirst().first {
        case "--version": return .version
        case "install": return .install
        case "remove": return .remove
        case "trust": return .trust
        default: return .usage
        }
    }
}

switch ProxyInstallMain.parse(argv: CommandLine.arguments) {
case .version:
    print("mattstack-proxy-install \(HelperVersion.value) protocol 1")
    exit(0)
case .usage:
    Report.step("usage: mattstack-proxy-install install|remove|trust|--version")
    Report.finish(ExitCode.usage)
case .install:
    Report.finish(InstallOp.run())
case .remove:
    Report.finish(RemoveOp.run())
case .trust:
    Report.finish(TrustOp.run())
}
