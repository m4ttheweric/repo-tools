import Foundation
import AppKit

/// Checks for new rt releases on GitHub and notifies the user.
///
/// Polls `https://api.github.com/repos/m4ttstack/rt/releases/latest`
/// on launch and every 6 hours. Compares the release tag against the installed
/// rt CLI version. When a newer version is found, fires a native macOS notification
/// and updates the menu item -- prompting the user to run `rt update`.
class UpdateChecker {

    static let shared = UpdateChecker()

    /// Cached CLI version (resolved once via `rt --version`, falls back to bundle version).
    private lazy var currentVersion: String = {
        if let cliVersion = Self.resolveCliVersion() {
            return cliVersion
        }
        return Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }()

    private let repoOwner = "m4ttstack"
    private let repoName = "rt"
    private let checkInterval: TimeInterval = 6 * 60 * 60 // 6 hours

    private var timer: Timer?
    private(set) var latestRelease: GitHubRelease?
    var onUpdateAvailable: ((GitHubRelease) -> Void)?

    // MARK: - Public

    var isDevBuild: Bool {
        #if DEBUG
        return true
        #else
        if BundleFlavor.isDevBuild { return true }
        if Self.isCliDevMode { return true }
        return currentVersion == "dev"
        #endif
    }

    /// The CLI is in dev mode when ~/.local/bin/rt exists (the dev-mode wrapper).
    private static var isCliDevMode: Bool {
        let home = NSHomeDirectory()
        return FileManager.default.fileExists(atPath: home + "/.local/bin/rt")
    }

    func startPeriodicChecks() {
        if isDevBuild {
            TrayLog.info("skipping update checks (dev build)")
            return
        }

        // Initial check after 30s (don't slow launch)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.checkForUpdates()
        }

        // Periodic checks
        timer = Timer.scheduledTimer(withTimeInterval: checkInterval, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
    }

    /// Check for updates.
    /// - Parameter userInitiated: When true, always shows a result dialog (update available or up to date).
    ///   Background checks (the default) are silent and only fire the callback when a newer version is found.
    func checkForUpdates(userInitiated: Bool = false) {
        // The dev bundle is fully silent (spec MAT-383 §3): no polling, and
        // no alert even from the gear menu. A dev build's version has no
        // meaningful relationship to the latest release, so every answer it
        // could give — "up to date", "update available" — would be noise.
        if BundleFlavor.isDevBuild {
            TrayLog.info("update check skipped (dev build)", ["userInitiated": userInitiated])
            return
        }

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
                TrayLog.warn("update check failed", ["err": error?.localizedDescription ?? "unknown"])
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
                        TrayLog.info("update available", ["remote": release.tagName, "current": self.currentVersion])
                        self.latestRelease = release
                        self.onUpdateAvailable?(release)
                        if userInitiated {
                            self.showRunUpdateAlert(release: release)
                        }
                    } else {
                        TrayLog.info("up to date (\(self.currentVersion))")
                        if userInitiated {
                            let current = self.currentVersion == "dev" ? "dev build" : "v\(self.currentVersion)"
                            self.showAlert(title: "You're up to date",
                                          message: "rt is at the latest release (\(release.tagName)).\nCurrent: \(current)")
                        }
                    }
                }
            } catch {
                TrayLog.warn("failed to decode release", ["err": String(describing: error)])
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

    // MARK: - Private

    private func showRunUpdateAlert(release: GitHubRelease) {
        let alert = NSAlert()
        alert.messageText = "mattstack \(release.tagName) Available"
        alert.informativeText = "Run the following in your terminal to upgrade:\n\n  rt update"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// Shells out to the Homebrew-installed rt binary for its version string.
    private static func resolveCliVersion() -> String? {
        let paths = ["/opt/homebrew/bin/rt", "/usr/local/bin/rt"]
        guard let rtPath = paths.first(where: { FileManager.default.fileExists(atPath: $0) }) else { return nil }

        guard let data = TrayLog.runLogged(rtPath, ["--version"], label: "rt --version") else { return nil }
        guard let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        let version = raw.hasPrefix("v") ? String(raw.dropFirst()) : raw
        return version
    }

    private func isNewerVersion(_ remote: String, than local: String) -> Bool {
        if local == "dev" { return false }
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
