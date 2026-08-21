import Foundation
import Security
import MattstackCore

final class PrivilegedInstaller: PrivilegedInstalling, @unchecked Sendable {
    private let bundlePath: String
    private let escalator: PrivilegeEscalator
    private let fileExists: @Sendable (String) -> Bool

    init(bundlePath: String, escalator: PrivilegeEscalator,
         fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) {
        self.bundlePath = bundlePath; self.escalator = escalator; self.fileExists = fileExists
    }

    func proxyInstall() async -> NeedResult { await run(op: "install") }
    func proxyRemove() async -> NeedResult { await run(op: "remove") }

    private func run(op: String) async -> NeedResult {
        let helper = ProxyHelper.path(bundlePath: bundlePath)
        guard fileExists(helper) else {
            return NeedResult(ok: false, detail: "proxy-install helper is not bundled at \(ProxyHelper.relativePath)")
        }
        let out = await escalator.runAsAdmin(executable: helper, args: [op], prompt: ProxyHelper.promptText)
        if out.ok { TrayLog.info("proxy helper ran", ["stdout": String(out.stdout.suffix(500))]) }
        else { TrayLog.warn("proxy helper failed", ["exit": Int(out.exitCode), "stderr": String(out.stderr.suffix(1000))]) }
        return NeedResult(ok: out.ok, detail: out.ok ? out.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                                                     : (out.stderr.isEmpty ? "exit \(out.exitCode)" : out.stderr))
    }
}

/// The one admin prompt (spec §7 "Privileged"). AuthorizationServices shows
/// the system dialog with our prompt; the helper then runs as root through
/// AuthorizationExecuteWithPrivileges, resolved at runtime because the
/// symbol is deprecated-but-supported and has no Swift overlay.
struct AuthorizationServicesEscalator: PrivilegeEscalator {
    private typealias ExecFn = @convention(c) (AuthorizationRef, UnsafePointer<CChar>, AuthorizationFlags,
                                               UnsafePointer<UnsafeMutablePointer<CChar>?>?,
                                               UnsafeMutablePointer<UnsafeMutablePointer<FILE>?>?) -> OSStatus

    func runAsAdmin(executable: String, args: [String], prompt: String) async -> CommandOutcome {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: Self.runBlocking(executable, args, prompt)) }
        }
    }

    private static func runBlocking(_ executable: String, _ args: [String], _ prompt: String) -> CommandOutcome {
        var authRef: AuthorizationRef?
        guard AuthorizationCreate(nil, nil, [], &authRef) == errAuthorizationSuccess, let auth = authRef else {
            return CommandOutcome(exitCode: 1, stdout: "", stderr: "AuthorizationCreate failed")
        }
        defer { AuthorizationFree(auth, [.destroyRights]) }

        // Both C-string pointers must stay alive for the AuthorizationCopyRights
        // call itself, not just the withCString scope that produced them — hence
        // the nesting, rather than letting either pointer escape its closure.
        var promptCopy = Array(prompt.utf8CString)
        let status: OSStatus = kAuthorizationRightExecute.withCString { rightName in
            kAuthorizationEnvironmentPrompt.withCString { envName in
                promptCopy.withUnsafeMutableBufferPointer { buf -> OSStatus in
                    var item = AuthorizationItem(name: rightName, valueLength: 0, value: nil, flags: 0)
                    var rights = AuthorizationItem_withRights(&item)
                    var envItem = AuthorizationItem(name: envName, valueLength: buf.count - 1, value: buf.baseAddress, flags: 0)
                    var env = AuthorizationItem_withRights(&envItem)
                    let flags: AuthorizationFlags = [.interactionAllowed, .extendRights, .preAuthorize]
                    return AuthorizationCopyRights(auth, &rights, &env, flags, nil)
                }
            }
        }
        guard status == errAuthorizationSuccess else {
            return CommandOutcome(exitCode: Int32(status), stdout: "", stderr: status == errAuthorizationCanceled ? "cancelled" : "authorization denied (\(status))")
        }

        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "AuthorizationExecuteWithPrivileges") else {
            return CommandOutcome(exitCode: 1, stdout: "", stderr: "AuthorizationExecuteWithPrivileges unavailable")
        }
        let exec = unsafeBitCast(sym, to: ExecFn.self)
        var cArgs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        defer { cArgs.forEach { free($0) } }
        var pipe: UnsafeMutablePointer<FILE>?
        let rc = executable.withCString { exe in exec(auth, exe, [], &cArgs, &pipe) }
        guard rc == errAuthorizationSuccess, let fp = pipe else {
            return CommandOutcome(exitCode: Int32(rc), stdout: "", stderr: "exec failed (\(rc))")
        }
        var output = ""
        var buf = [CChar](repeating: 0, count: 4096)
        while fgets(&buf, Int32(buf.count), fp) != nil { output += String(cString: buf) }
        fclose(fp)
        // The helper prints "MATTSTACK_EXIT=<n>" as its last line so the
        // caller learns the real status (the API does not report it).
        let exit = output.split(separator: "\n").last.flatMap { $0.hasPrefix("MATTSTACK_EXIT=") ? Int32($0.dropFirst("MATTSTACK_EXIT=".count)) : nil } ?? 0
        return CommandOutcome(exitCode: exit, stdout: output, stderr: exit == 0 ? "" : output)
    }

    private static func AuthorizationItem_withRights(_ item: inout AuthorizationItem) -> AuthorizationRights {
        withUnsafeMutablePointer(to: &item) { AuthorizationRights(count: 1, items: $0) }
    }
}
