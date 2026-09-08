import Foundation

enum Op: Equatable { case version, install, remove, usage }

enum ProxyInstallMain {
    static func parse(argv: [String]) -> Op {
        switch argv.dropFirst().first {
        case "--version": return .version
        case "install": return .install
        case "remove": return .remove
        default: return .usage
        }
    }
}

switch ProxyInstallMain.parse(argv: CommandLine.arguments) {
case .version:
    print("mattstack-proxy-install \(HelperVersion.value) protocol 1")
    exit(0)
case .usage:
    Report.step("usage: mattstack-proxy-install install|remove|--version")
    Report.finish(ExitCode.usage)
case .install:
    Report.finish(InstallOp.run())
case .remove:
    Report.finish(RemoveOp.run())
}
