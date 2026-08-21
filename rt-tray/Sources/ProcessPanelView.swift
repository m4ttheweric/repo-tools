import SwiftUI
import AppKit
import ServiceManagement

// MARK: - Main View

struct ProcessPanelView: View {
    /// True when hosted in the standalone window, where the pop-out
    /// button would be a no-op pointing at itself.
    var isDetached: Bool = false

    @StateObject private var controller = ProcessPanelController()
    @StateObject private var columnSettings = ColumnSettings()
    @ObservedObject private var trayState = TrayState.shared
    @State private var showColumnPicker = false
    @State private var startAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        VStack(spacing: 0) {
            statusStrip
            if trayState.needsApproval {
                approvalRow
            }
            Divider()
            headerBar
            Divider()
            if controller.isLoading || !controller.scannerReady {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if controller.filteredGroups.isEmpty {
                emptyState
            } else {
                processTable
            }
            Divider()
            footerBar
        }
        .frame(minWidth: 600, idealWidth: 900, maxWidth: .infinity,
               minHeight: 400, idealHeight: 600, maxHeight: .infinity)
        .onAppear { controller.startPolling() }
        .onDisappear { controller.stopPolling() }
    }

    // MARK: - Status Strip

    /// The former tray menu, collapsed into the panel: daemon health +
    /// status on the left, operational verbs behind a gear on the right.
    private var statusStrip: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(trayState.healthColor)
                .frame(width: 9, height: 9)
            Text(trayState.statusText)
                .font(.system(size: 12))
                .foregroundColor(.secondary)

            Spacer(minLength: 4)
            SearchField(text: $controller.searchText)
                .frame(width: 180)

            PanelMenu(icon: "gearshape", makeMenu: makeGearMenu)
                .help("Daemon and app controls")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func makeGearMenu() -> NSMenu {
        let menu = NSMenu()
        // NSMenu.autoenablesItems defaults true and re-enables any item whose
        // target has no validateMenuItem — that would silently override the
        // Check for Updates item's explicit isEnabled below.
        menu.autoenablesItems = false
        menu.addItem(ActionMenuItem("Restart Daemon") {
            NotificationCenter.default.post(name: .rtRestartDaemon, object: nil)
        })
        menu.addItem(ActionMenuItem("Stop Daemon") {
            NotificationCenter.default.post(name: .rtStopDaemon, object: nil)
        })
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("View Logs…") {
            NotificationCenter.default.post(name: .rtViewDaemonLogs, object: nil)
        })
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Setup status…", axid: AXID.menuGearSetupStatus) {
            NotificationCenter.default.post(name: .rtShowSetupStatus, object: nil)
        })
        menu.addItem(ActionMenuItem("Settings…", axid: AXID.menuGearSettings) {
            NotificationCenter.default.post(name: .rtShowSettings, object: nil)
        })
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Start at Login", state: startAtLogin ? .on : .off) {
            toggleStartAtLogin()
        })
        menu.addItem(.separator())
        let updateItem = ActionMenuItem(updateMenuTitle, axid: AXID.menuGearCheckForUpdates) {
            NotificationCenter.default.post(name: .rtCheckUpdates, object: nil)
        }
        updateItem.isEnabled = trayState.canCheckForUpdates || trayState.updateAvailable != nil
        menu.addItem(updateItem)
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Uninstall mattstack…", axid: AXID.menuGearUninstall) {
            NotificationCenter.default.post(name: .rtShowUninstall, object: nil)
        })
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Quit mattstack") {
            NSApplication.shared.terminate(nil)
        })
        return menu
    }

    /// The user's start-at-login switch — and the authority on it.
    ///
    /// AppDelegate auto-registers the login item at startup so a flavor
    /// switch (spec MAT-383 §3) doesn't silently lose it. That must never
    /// undo a deliberate OFF, so turning it off here records an opt-out and
    /// turning it back on clears it. The flag is written only after the
    /// SMAppService call actually succeeds — a failed unregister leaves the
    /// item enabled, and recording an opt-out for it would lie.
    private func toggleStartAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
                LoginItemPreference.isOptedOut = true
            } else {
                try SMAppService.mainApp.register()
                LoginItemPreference.isOptedOut = false
            }
        } catch {
            TrayLog.error("login item toggle failed", ["err": String(describing: error)])
        }
        startAtLogin = SMAppService.mainApp.status == .enabled
    }

    private var updateMenuTitle: String {
        if let tag = trayState.updateAvailable {
            return "Update Available: \(tag)"
        }
        return "Check for Updates…"
    }

    private var approvalRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundColor(.orange)
            Text("The rt daemon needs approval to run at login.")
                .font(.caption)
            Spacer()
            PanelButton(label: "Open Login Items…", icon: nil, action: {
                SMAppService.openSystemSettingsLoginItems()
            })
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.orange.opacity(0.08))
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack(spacing: 6) {
            // Scrolls so a long repo list can never push the action
            // cluster off the right edge.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    PanelChip("All", selected: controller.selectedRepo == nil) {
                        controller.selectedRepo = nil
                    }
                    ForEach(controller.repoNames, id: \.self) { repo in
                        PanelChip(repo, selected: controller.selectedRepo == repo) {
                            controller.selectedRepo = repo
                        }
                    }
                }
            }

            Spacer(minLength: 12)

            if !controller.selection.isEmpty {
                PanelButton(
                    label: "Kill \(controller.selection.count)",
                    icon: "xmark.circle",
                    role: .destructive,
                    action: { controller.killSelected() }
                )
                .help("Kill the selected processes")
            }

            Text(processCountText)
                .font(.system(size: 12))
                .foregroundColor(.secondary)

            PanelButton(label: nil, icon: "slider.horizontal.3", action: {
                showColumnPicker.toggle()
            })
            .help("Configure columns")
            .popover(isPresented: $showColumnPicker) {
                columnPickerView
            }

            PanelButton(
                label: nil,
                icon: "arrow.clockwise",
                isLoading: controller.isRefreshing,
                action: { controller.refresh(userInitiated: true) }
            )
            .help("Refresh")

            if !isDetached {
                PanelButton(label: nil, icon: "arrow.up.left.and.arrow.down.right", action: {
                    NotificationCenter.default.post(name: .detachProcessPanel, object: nil)
                })
                .help("Open in window")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var processCountText: String {
        let total = controller.totalProcessCount
        if controller.searchText.isEmpty {
            return total == 1 ? "1 process" : "\(total) processes"
        }
        return "\(controller.filteredProcessCount) of \(total)"
    }

    private var columnPickerView: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Columns")
                .font(.caption.weight(.semibold))
                .padding(.bottom, 2)
            ForEach(ProcessColumn.allCases, id: \.self) { col in
                Toggle(col.rawValue, isOn: Binding(
                    get: { columnSettings.visibleColumns.contains(col) },
                    set: { _ in columnSettings.toggle(col) }
                ))
                .font(.caption)
                .toggleStyle(.checkbox)
                // ColumnSettings.toggle refuses to hide the last column;
                // disable the checkbox so that isn't a silent no-op.
                .disabled(columnSettings.visibleColumns == [col])
            }
        }
        .padding(12)
    }

    // MARK: - Process Table (NSOutlineView)

    private var processTable: some View {
        ProcessOutlineView(
            groups: controller.filteredGroups,
            visibleColumns: columnSettings.visibleColumns,
            killingPids: controller.killingPids,
            herdrPids: controller.herdrRowPids,
            selection: controller.selection,
            dataVersion: controller.dataVersion,
            searchText: controller.searchText,
            controller: controller
        )
    }

    // MARK: - Empty & Footer

    private var emptyState: some View {
        VStack(spacing: 8) {
            if controller.lastRefreshFailed {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title)
                    .foregroundColor(.secondary)
                Text("Can't reach the rt daemon")
                    .font(.caption)
                    .foregroundColor(.secondary)
                PanelButton(label: "Retry", icon: "arrow.clockwise", action: {
                    controller.refresh(userInitiated: true)
                })
            } else {
                Image(systemName: "checkmark.circle")
                    .font(.title)
                    .foregroundColor(.secondary)
                Text("No processes running")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var footerBar: some View {
        HStack {
            Text("Updated \(controller.lastUpdated, style: .relative) ago")
                .font(.caption2)
                .foregroundColor(.secondary)
            Spacer()
            if let status = controller.status {
                Text(status.text)
                    .font(.caption2)
                    .foregroundColor(status.isError ? .red : .secondary)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .animation(.easeInOut(duration: 0.2), value: controller.status)
    }
}

// MARK: - Reusable UI Components

struct PanelChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void

    @State private var isHovering = false

    init(_ label: String, selected: Bool, action: @escaping () -> Void) {
        self.label = label
        self.selected = selected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(chipBackground)
                .cornerRadius(5)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .onHover { isHovering = $0 }
    }

    private var chipBackground: Color {
        if selected {
            return Color.accentColor.opacity(isHovering ? 0.28 : 0.2)
        }
        if isHovering {
            return Color.primary.opacity(0.06)
        }
        return Color.clear
    }
}

/// A menu trigger dressed as a PanelButton. A plain SwiftUI button (so hover
/// styling actually renders — SwiftUI's Menu label ignores state changes
/// under the borderless style) that pops a native NSMenu anchored below it.
struct PanelMenu: View {
    let icon: String
    let makeMenu: () -> NSMenu

    @State private var isHovering = false
    @State private var anchorView: NSView?

    var body: some View {
        Button(action: showMenu) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .frame(width: 16, height: 16)
                .foregroundColor(isHovering ? .primary : .secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(isHovering ? Color.primary.opacity(0.06) : Color.clear)
                .cornerRadius(4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .onHover { isHovering = $0 }
        .background(MenuAnchor { anchorView = $0 })
    }

    private func showMenu() {
        let menu = makeMenu()
        guard let view = anchorView, let window = view.window else {
            menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
            return
        }
        // Screen coordinates (y-up): the menu's top-left lands at the given
        // point, so aim just under the button's bottom edge.
        let rectInWindow = view.convert(view.bounds, to: nil)
        let rectOnScreen = window.convertToScreen(rectInWindow)
        menu.popUp(
            positioning: nil,
            at: NSPoint(x: rectOnScreen.minX, y: rectOnScreen.minY - 4),
            in: nil
        )
    }
}

/// Invisible NSView that hands its handle back so NSMenu.popUp can anchor
/// to the SwiftUI button's position.
private struct MenuAnchor: NSViewRepresentable {
    let onResolve: (NSView) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { onResolve(view) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// NSMenuItem that runs a closure — NSMenu wants target/selector pairs.
final class ActionMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, state: NSControl.StateValue = .off, axid: String? = nil, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(invoke), keyEquivalent: "")
        self.target = self
        self.state = state
        if let axid { setAccessibilityIdentifier(axid) }
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @objc private func invoke() {
        handler()
    }
}

struct SearchField: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> KeyableSearchField {
        let field = KeyableSearchField()
        field.placeholderString = "Filter"
        field.controlSize = .small
        field.font = .systemFont(ofSize: 12)
        field.focusRingType = .none
        field.delegate = context.coordinator
        field.sendsSearchStringImmediately = true
        field.sendsWholeSearchString = false
        return field
    }

    func updateNSView(_ nsView: KeyableSearchField, context: Context) {
        if nsView.stringValue != text {
            nsView.stringValue = text
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    class Coordinator: NSObject, NSSearchFieldDelegate {
        let text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSSearchField else { return }
            text.wrappedValue = field.stringValue
        }
    }
}

/// NSSearchField that handles Cmd+A/C/V/X/Z itself so they work in
/// menu-bar panels where the app menu's key equivalents intercept them.
final class KeyableSearchField: NSSearchField {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.contains(.command),
              let chars = event.charactersIgnoringModifiers else {
            return super.performKeyEquivalent(with: event)
        }
        switch chars {
        case "a": currentEditor()?.selectAll(nil); return true
        case "c": currentEditor()?.copy(nil); return true
        case "v": currentEditor()?.paste(nil); return true
        case "x": currentEditor()?.cut(nil); return true
        case "z":
            if event.modifierFlags.contains(.shift) {
                currentEditor()?.undoManager?.redo()
            } else {
                currentEditor()?.undoManager?.undo()
            }
            return true
        default: return super.performKeyEquivalent(with: event)
        }
    }
}

struct PanelButton: View {
    let label: String?
    let icon: String?
    var role: ButtonRole? = nil
    var isLoading: Bool = false
    let action: () -> Void

    @State private var isHovering = false

    enum ButtonRole {
        case destructive
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                // Fixed slot: the spinner and the icon it replaces render
                // at slightly different sizes, which otherwise makes the
                // whole header shuffle on every refresh.
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.8)
                        .frame(width: 16, height: 16)
                } else if let icon = icon {
                    Image(systemName: icon)
                        .font(.system(size: 13))
                        .frame(width: 16, height: 16)
                }
                if let label = label {
                    Text(label)
                        .font(.system(size: 12))
                }
            }
            .foregroundColor(foregroundColor)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(isHovering ? hoverBackground : Color.clear)
            .cornerRadius(4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(isLoading)
        .onHover { isHovering = $0 }
    }

    private var foregroundColor: Color {
        if isLoading { return .secondary }
        if role == .destructive { return .red }
        return isHovering ? .primary : .secondary
    }

    private var hoverBackground: Color {
        if role == .destructive { return Color.red.opacity(0.1) }
        return Color.primary.opacity(0.06)
    }
}
