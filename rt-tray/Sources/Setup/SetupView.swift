import SwiftUI
import MattstackCore

struct SetupView: View {
    @ObservedObject var flow: SetupFlowModel
    @ObservedObject var team: TeamChoiceModel
    @ObservedObject var readiness: ReadinessModel
    @ObservedObject var install: InstallRunModel
    let permissions: PermissionsService
    let env: SetupEnvironment
    let onFinish: () -> Void
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
                case .checklist: ChecklistScreen(model: readiness, permissions: permissions, rt: env.rt).transition(pushTransition)
                case .install: InstallScreen(model: install).transition(pushTransition)
                case .done: DoneScreen(install: install, isOwner: team.choice == .create, onInvite: { NotificationCenter.default.post(name: .rtShowSettingsTeam, object: nil) }).transition(pushTransition)
                }
            }
            .animation(.easeInOut(duration: 0.22), value: flow.step)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let errorText {
                Text(errorText)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20).padding(.vertical, 8)
                    .accessibilityIdentifier(AXID.error(screenName))
            }
            Divider()
            footer
        }
        .frame(width: SetupWindowController.width)
        .frame(minHeight: 560)
        .controlSize(.large)
        // .task(id:) reruns on the *initial* value too (unlike onChange), so a
        // deep link that opens straight into .checklist or .install still
        // loads/starts — onChange alone would silently no-op on first appear.
        .task(id: flow.step) {
            if flow.step == .checklist {
                if !flow.readinessIsVisible { flow.readinessIsVisible = true; readiness.becameVisible() }
                await readiness.load()
            } else if flow.readinessIsVisible {
                flow.readinessIsVisible = false
                readiness.becameHidden()
            }
            if flow.step == .install { flow.isInstalling = true; install.start() }
        }
        .onChange(of: install.phase) { _, phase in
            flow.isInstalling = (phase == .running)
            if flow.step == .install, phase == .succeeded { flow.next() }
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
            Spacer()
            // Always present (never removed) so the AX walkthrough finds a
            // stable setup.<screen>.back element and reads its enabled state.
            Button("Back") { flow.back() }
                .disabled(!flow.canGoBack)
                .accessibilityIdentifier(AXID.back(screenName))
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
            onFinish()
        default:
            flow.next()
        }
    }
}

extension Notification.Name {
    static let rtShowSettingsTeam = Notification.Name("rtShowSettingsTeam")
}
