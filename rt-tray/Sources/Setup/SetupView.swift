import SwiftUI
import MattstackCore

struct SetupView: View {
    @ObservedObject var flow: SetupFlowModel
    @ObservedObject var team: TeamChoiceModel
    @ObservedObject var readiness: ReadinessModel
    @ObservedObject var install: InstallRunModel
    let permissions: PermissionsService
    let env: SetupEnvironment
    @State private var busy = false
    @State private var errorText: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ZStack {
                switch flow.step {
                case .welcome: WelcomeScreen().transition(pushTransition)
                case .team: TeamScreen(model: team).transition(pushTransition)
                case .checklist: ChecklistScreen(model: readiness, permissions: permissions, rt: env.rt, bundleId: env.bundleId).transition(pushTransition)
                case .install: InstallScreen(model: install).transition(pushTransition)
                case .done: DoneScreen(install: install, isOwner: team.choice == .create, onInvite: { NotificationCenter.default.post(name: .rtShowSettingsTeam, object: nil) }).transition(pushTransition)
                }
            }
            .animation(.easeInOut(duration: 0.22), value: flow.step)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .frame(width: SetupWindowController.width)
        .frame(minHeight: 560)
        .controlSize(.large)
        .onChange(of: flow.step) { _, step in
            if step == .checklist { readiness.becameVisible(); Task { await readiness.load() } } else { readiness.becameHidden() }
            if step == .install { flow.isInstalling = true; install.start() }
        }
        .onChange(of: install.phase) { _, phase in
            flow.isInstalling = (phase == .running)
            if phase == .succeeded { flow.next() }
        }
    }

    private var pushTransition: AnyTransition {
        .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .move(edge: .leading).combined(with: .opacity))
    }

    private var header: some View {
        HStack {
            Text(flow.step.title).font(.title2.weight(.semibold))
            Spacer()
            Text(flow.step.indicator).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier(AXID.stepIndicator)
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    private var footer: some View {
        HStack {
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red).lineLimit(2) }
            Spacer()
            if flow.canGoBack {
                Button("Back") { flow.back() }.accessibilityIdentifier(AXID.back(screenName))
            }
            if flow.step == .checklist, readiness.limitedModeAvailable {
                Button("Continue in limited mode") { flow.next() }.accessibilityIdentifier(AXID.continueLimited)
            }
            Button(flow.continueTitle) { Task { await advance() } }
                .keyboardShortcut(.defaultAction)
                .disabled(!continueEnabled || busy)
                .accessibilityIdentifier(AXID.continue(screenName))
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    private var screenName: String { String(describing: flow.step) }

    private var continueEnabled: Bool {
        switch flow.step {
        case .welcome: return true
        case .team: return team.canContinue
        case .checklist: return readiness.canInstall
        case .install: return install.phase == .succeeded
        case .done: return true
        }
    }

    private func advance() async {
        errorText = nil
        switch flow.step {
        case .team:
            busy = true; defer { busy = false }
            if let err = await team.validateAndPrepare() { errorText = err; return }
            flow.next()
        case .done:
            NSApp.keyWindow?.close()
        default:
            flow.next()
        }
    }
}

extension Notification.Name {
    static let rtShowSettingsTeam = Notification.Name("rtShowSettingsTeam")
}
