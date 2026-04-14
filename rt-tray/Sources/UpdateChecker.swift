import Foundation
import AppKit

/// Checks for new rt releases on GitHub and notifies the user.
///
/// Polls `https://api.github.com/repos/m4ttheweric/repo-tools/releases/latest`
/// on launch and every 6 hours. Compares the release tag against the embedded
/// build version. When a newer version is found, fires a native macOS notification
/// and enables the "Check for Updates…" menu action.
class UpdateChecker {

    static let shared = UpdateChecker()

    /// The build version from Info.plist (set by build.sh at build time).
    private var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }

    private let repoOwner = "m4ttheweric"
    private let repoName = "repo-tools"
    private let checkInterval: TimeInterval = 6 * 60 * 60 // 6 hours

    private var timer: Timer?
    private(set) var latestRelease: GitHubRelease?
    var onUpdateAvailable: ((GitHubRelease) -> Void)?

    // MARK: - Public

    func startPeriodicChecks() {
        // Initial check after 30s (don't slow launch)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.checkForUpdates()
        }

        // Periodic checks
        timer = Timer.scheduledTimer(withTimeInterval: checkInterval, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
    }

    /// Background check — silent, skips dev builds, only fires callback if newer version found.
    func checkForUpdates() {
        checkForUpdates(userInitiated: false)
    }

    /// Check for updates.
    /// - Parameter userInitiated: When true, always shows a result dialog (update available or up to date).
    func checkForUpdates(userInitiated: Bool) {
        let urlString = "https://api.github.com/repos/\(repoOwner)/\(repoName)/releases/latest"
        guard let url = URL(string: urlString) else { return }

        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            guard let data = data,
                  error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                NSLog("rt-tray: update check failed: \(error?.localizedDescription ?? "unknown")")
                if userInitiated {
                    DispatchQueue.main.async {
                        self.showAlert(title: "Update Check Failed",
                                      message: "Could not reach GitHub. Check your internet connection and try again.")
                    }
                }
                return
            }

            do {
                let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
                let remoteVersion = release.tagName.trimmingCharacters(in: CharacterSet(charactersIn: "v"))
                let isNewer = self.isNewerVersion(remoteVersion, than: self.currentVersion)

                DispatchQueue.main.async {
                    if isNewer {
                        NSLog("rt-tray: update available: \(release.tagName) (current: \(self.currentVersion))")
                        self.latestRelease = release
                        self.onUpdateAvailable?(release)
                        // For user-initiated checks, also immediately offer to install
                        if userInitiated {
                            self.installUpdate(release: release)
                        }
                    } else {
                        NSLog("rt-tray: up to date (\(self.currentVersion))")
                        if userInitiated {
                            let current = self.currentVersion == "dev" ? "dev build" : "v\(self.currentVersion)"
                            self.showAlert(title: "You're up to date",
                                          message: "rt is at the latest release (\(release.tagName)).\nCurrent: \(current)")
                        }
                    }
                }
            } catch {
                NSLog("rt-tray: failed to decode release: \(error)")
                if userInitiated {
                    DispatchQueue.main.async {
                        self.showAlert(title: "Update Check Failed",
                                      message: "Could not parse the release data from GitHub.")
                    }
                }
            }
        }.resume()
    }

    func stopChecking() {
        timer?.invalidate()
        timer = nil
    }

    /// Install the update via Homebrew — keeps version tracking consistent
    /// and runs post_install hooks (daemon, extension, shell integration).
    func installUpdate(release: GitHubRelease) {
        let alert = NSAlert()
        alert.messageText = "Update to \(release.tagName)?"
        alert.informativeText = "This will run `brew upgrade rt` in the background."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Update")
        alert.addButton(withTitle: "Cancel")

        guard alert.runModal() == .alertFirstButtonReturn else { return }

        Task {
            let success = await runBrewUpgrade()
            await MainActor.run {
                if success {
                    let done = NSAlert()
                    done.messageText = "Update Complete"
                    done.informativeText = "rt has been updated to \(release.tagName).\n\nRestart rt-tray to use the new version."
                    done.alertStyle = .informational
                    done.addButton(withTitle: "Restart Now")
                    done.addButton(withTitle: "Later")

                    if done.runModal() == .alertFirstButtonReturn {
                        // Relaunch ourselves
                        let url = Bundle.main.bundleURL
                        NSWorkspace.shared.openApplication(
                            at: url,
                            configuration: .init()
                        )
                        NSApplication.shared.terminate(nil)
                    }
                } else {
                    showAlert(title: "Update Failed",
                             message: "brew upgrade rt failed.\n\nTry running it manually in Terminal.")
                }
            }
        }
    }

    // MARK: - Private

    private func isNewerVersion(_ remote: String, than local: String) -> Bool {
        if local == "dev" { return false } // dev builds never auto-update
        let remoteParts = remote.split(separator: ".").compactMap { Int($0) }
        let localParts = local.split(separator: ".").compactMap { Int($0) }

        for i in 0..<max(remoteParts.count, localParts.count) {
            let r = i < remoteParts.count ? remoteParts[i] : 0
            let l = i < localParts.count ? localParts[i] : 0
            if r > l { return true }
            if r < l { return false }
        }
        return false
    }

    private func runBrewUpgrade() async -> Bool {
        // Resolve brew path — Homebrew may be in different locations
        let brewPaths = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        guard let brewPath = brewPaths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            NSLog("rt-tray: brew not found")
            return false
        }

        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: brewPath)
                process.arguments = ["upgrade", "m4ttheweric/tap/rt"]

                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe

                do {
                    try process.run()
                    process.waitUntilExit()

                    let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                    NSLog("rt-tray: brew upgrade output: \(output)")

                    continuation.resume(returning: process.terminationStatus == 0)
                } catch {
                    NSLog("rt-tray: brew upgrade failed: \(error)")
                    continuation.resume(returning: false)
                }
            }
        }
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.runModal()
    }
}

// MARK: - Models

struct GitHubRelease: Decodable {
    let tagName: String
    let name: String?
    let body: String?
    let htmlUrl: String

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case name, body
        case htmlUrl = "html_url"
    }
}
