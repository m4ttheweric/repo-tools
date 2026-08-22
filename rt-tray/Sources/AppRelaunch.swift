import AppKit
import MattstackCore

/// Shared by the Setup checklist and Settings > Permissions relaunch buttons
/// (both prompt this after a permission grant that only takes effect on the
/// next launch).
enum AppRelaunch {
    static func relaunchInPlace() {
        let path = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        // Re-exec with the current arguments + environment so a clean-room
        // launch (`MATTSTACK_APPCAST_URL` + `--allow-appcast-override`)
        // survives the relaunch; `open` does not inherit either on its own.
        var args = ["-n", path]
        if let feed = ProcessInfo.processInfo.environment[UpdatePolicy.overrideEnv] { args += ["--env", "\(UpdatePolicy.overrideEnv)=\(feed)"] }
        let passthrough = Array(CommandLine.arguments.dropFirst())
        if !passthrough.isEmpty { args += ["--args"] + passthrough }
        task.arguments = args
        try? task.run()
        NSApp.terminate(nil)
    }
}
