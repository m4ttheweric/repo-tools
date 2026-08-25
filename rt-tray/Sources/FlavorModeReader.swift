import Foundation
import MattstackCore

// MARK: - FlavorGateState

/// The gate's verdict. A global because it is decided in `main.swift`, before
/// any object graph exists, and read afterwards by both the AppDelegate and
/// the alert's switch path.
enum FlavorGateState {
    static var action: FlavorGate.Action = .serve

    /// Set only when the read actually named this flavor. Serving on a failed
    /// read is a safe default, never a mandate to evict the tray that is
    /// already working.
    static var intentConfirmed = false

    /// A launch that served because it could not read the intent owes the
    /// question one more attempt, once, when the user next activates the app.
    static var readFailed = false
    static var recheckStarted = false
}

// MARK: - FlavorModeReader

/// Reads the machine's intended mode by running `rt settings dev-mode --json`
/// through the same locator the rest of the app resolves rt with.
///
/// Runs on the main thread before the run loop starts, so it is hard-bounded:
/// a wedged or slow rt costs `timeout` seconds of launch and then reads as a
/// failure, which the gate treats as "serve".
enum FlavorModeReader {

    static func readTuple(timeout: TimeInterval = 2) -> String? {
        // The stub harness drives a scripted rt with no notion of flavor
        // intent; letting its reply reach the gate could stand a UI-test tray
        // down mid-scenario.
        guard !BundleFlavor.isStubActive else {
            TrayLog.info("mode read skipped (stub mode)")
            return nil
        }
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        guard let loc = RtBinaryLocator.resolve(bundlePath: Bundle.main.bundlePath, isDevBuild: BundleFlavor.isDevBuild,
                                                isDebugBuild: debug, environment: ProcessInfo.processInfo.environment,
                                                home: AppHome.current, fileExists: { FileManager.default.isExecutableFile(atPath: $0) })
        else {
            TrayLog.warn("mode read skipped: no rt for this bundle", ["bundle": Bundle.main.bundlePath])
            return nil
        }

        let task = Process()
        task.executableURL = loc.executable
        task.arguments = loc.argumentPrefix + ["settings", "dev-mode", "--json"]
        let out = Pipe()
        task.standardOutput = out
        // Nothing on this path drains a second pipe, and a chatty rt must not
        // be able to block on one we own.
        task.standardError = FileHandle.nullDevice
        task.standardInput = FileHandle.nullDevice
        do {
            try task.run()
        } catch {
            TrayLog.warn("mode read failed to start", ["cmd": loc.executable.path, "err": String(describing: error)])
            return nil
        }

        let captured = DataBox()
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            captured.set(out.fileHandleForReading.readDataToEndOfFile())
            finished.signal()
        }
        // The read, not the exit, is what's waited on: a grandchild holding
        // rt's stdout can outlive rt itself, and this is the thread the whole
        // launch is queued behind.
        guard finished.wait(timeout: .now() + timeout) == .success else {
            task.terminate()
            TrayLog.warn("mode read timed out", ["seconds": timeout])
            return nil
        }
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            TrayLog.warn("mode read exited nonzero", ["exit": Int(task.terminationStatus)])
            return nil
        }
        return String(decoding: captured.get(), as: UTF8.self)
    }
}

/// Hands the captured stdout back across the queue boundary the semaphore
/// already orders.
private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Data()
    func set(_ data: Data) { lock.lock(); value = data; lock.unlock() }
    func get() -> Data { lock.lock(); defer { lock.unlock() }; return value }
}
