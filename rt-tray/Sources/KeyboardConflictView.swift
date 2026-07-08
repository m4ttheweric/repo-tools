import SwiftUI

struct KeyboardConflictView: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Header
                HStack(spacing: 12) {
                    Image(systemName: "keyboard")
                        .font(.system(size: 28))
                        .foregroundColor(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Keyboard Shortcut Conflict")
                            .font(.title2.bold())
                        Text("Control+Up is reserved by Mission Control")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                }
                .padding(.bottom, 4)

                Text("rt uses **Control+Up** for keyboard navigation, but macOS assigns this shortcut to Mission Control by default. While Mission Control has it, the key won't reach rt.")
                    .font(.body)

                Divider()

                Text("How to fix")
                    .font(.headline)

                VStack(alignment: .leading, spacing: 12) {
                    step(1, "Open **System Settings** and go to **Keyboard > Keyboard Shortcuts**")
                    step(2, "Select **Mission Control** in the sidebar")
                    step(3, "Uncheck the **Mission Control** shortcut (Control+Up Arrow)")
                }

                // CTA
                HStack {
                    Button("Open Keyboard Settings") {
                        openKeyboardSettings()
                    }
                    .buttonStyle(.borderedProminent)

                    Spacer()

                    Button("Dismiss") {
                        NSApp.keyWindow?.close()
                    }
                }
                .padding(.vertical, 4)

                // Screenshot
                if let image = loadScreenshot() {
                    Image(nsImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .cornerRadius(8)
                        .shadow(color: .black.opacity(0.2), radius: 4, y: 2)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(24)
        }
        .frame(width: 560)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.caption.bold())
                .foregroundColor(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
            Text(text)
                .font(.body)
        }
    }

    private func loadScreenshot() -> NSImage? {
        if let url = Bundle.main.url(forResource: "mission-control-screenshot", withExtension: "png") {
            return NSImage(contentsOf: url)
        }
        return nil
    }

    private func openKeyboardSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension")!
        NSWorkspace.shared.open(url)
    }
}
