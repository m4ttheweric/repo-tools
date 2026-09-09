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

    func proxyInstall() async -> NeedResult { await run(op: "install", prompt: ProxyHelper.promptText) }
    func proxyRemove() async -> NeedResult { await run(op: "remove", prompt: ProxyHelper.removePromptText) }
    func proxyTrust() async -> NeedResult { await run(op: "trust", prompt: ProxyHelper.trustPromptText) }

    private func run(op: String, prompt: String) async -> NeedResult {
        let helper = ProxyHelper.path(bundlePath: bundlePath)
        guard fileExists(helper) else {
            return NeedResult(ok: false, detail: "proxy-install helper is not bundled at \(ProxyHelper.relativePath)")
        }
        let out = await escalator.runAsAdmin(executable: helper, args: [op], prompt: prompt)
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

        // Every pointer here (both C-strings and both AuthorizationItems) must
        // stay alive through AuthorizationCopyRights itself, not just through
        // the withCString/withUnsafeMutablePointer scope that produced it —
        // hence nesting AuthorizationCopyRights as the innermost consuming call.
        var promptCopy = Array(prompt.utf8CString)
        let status: OSStatus = kAuthorizationRightExecute.withCString { rightName in
            kAuthorizationEnvironmentPrompt.withCString { envName in
                promptCopy.withUnsafeMutableBufferPointer { buf -> OSStatus in
                    var item = AuthorizationItem(name: rightName, valueLength: 0, value: nil, flags: 0)
                    var envItem = AuthorizationItem(name: envName, valueLength: buf.count - 1, value: buf.baseAddress, flags: 0)
                    let flags: AuthorizationFlags = [.interactionAllowed, .extendRights, .preAuthorize]
                    return withUnsafeMutablePointer(to: &item) { ip in
                        withUnsafeMutablePointer(to: &envItem) { ep in
                            var rights = AuthorizationRights(count: 1, items: ip)
                            var env = AuthorizationEnvironment(count: 1, items: ep)
                            return AuthorizationCopyRights(auth, &rights, &env, flags, nil)
                        }
                    }
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
        // AuthorizationExecuteWithPrivileges pipes only the child's stdout —
        // there is no separate stderr channel here — so the helper must print
        // both its diagnostics and the "MATTSTACK_EXIT=<n>" status trailer
        // (the API itself never reports the child's real exit code) on
        // stdout. The trailer line is parsed for the exit code, then
        // stripped so it never leaks into NeedResult.detail or the log.
        var lines = output.components(separatedBy: "\n")
        var exit: Int32 = 0
        if let idx = lines.lastIndex(where: { !$0.isEmpty }), lines[idx].hasPrefix("MATTSTACK_EXIT=") {
            exit = Int32(lines[idx].dropFirst("MATTSTACK_EXIT=".count)) ?? 0
            lines.remove(at: idx)
        }
        let cleaned = lines.joined(separator: "\n")
        return CommandOutcome(exitCode: exit, stdout: cleaned, stderr: exit == 0 ? "" : cleaned)
    }
}
