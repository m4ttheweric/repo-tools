import Foundation

public extension RtResult {
    /// Same shape as `failureCopy(verb:)`, but for actions whose stdin carried
    /// a secret (a connect token, an invite code): a misbehaving subprocess
    /// can echo its input on stderr, so the excerpt is withheld rather than
    /// shown or logged.
    func failureCopy(verb: String, redactStderr: Bool) -> String {
        guard redactStderr else { return failureCopy(verb: verb) }
        guard exitCode != 0 else { return "rt \(verb) returned an unexpected reply." }
        return "rt \(verb) failed (exit \(exitCode)); details withheld because the command carried a secret."
    }
}

public extension RtClientError {
    /// User-facing text — never the raw error description, which can carry
    /// a file path or other detail not meant for the setup UI.
    var copy: String {
        switch self {
        case .spawnFailed: return "rt failed to start."
        case .exited(let code, _): return "rt exited unexpectedly (exit \(code))."
        }
    }
}
