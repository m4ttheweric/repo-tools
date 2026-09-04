import Foundation
import Combine

public enum SetupStep: Int, CaseIterable, Sendable {
    case welcome, team, checklist, install, done

    public var title: String {
        switch self {
        case .welcome: return "Welcome to mattstack"
        case .team: return "Your team"
        case .checklist: return "Before we begin"
        case .install: return "Installing"
        case .done: return "Installed"
        }
    }
    public var indicator: String { "Step \(rawValue + 1) of \(SetupStep.allCases.count)" }
}

/// Custom page model: push transitions, Back never dismisses, the window
/// only closes once setup is done.
@MainActor
public final class SetupFlowModel: ObservableObject {
    @Published public var step: SetupStep = .welcome
    @Published public var isInstalling = false
    /// True while the checklist screen has an outstanding
    /// `readiness.becameVisible()`. Both the step-transition site (entering
    /// or leaving `.checklist`) and the window-close site read and clear
    /// this same flag, so a `becameHidden()` from either one only ever
    /// fires when a matching `becameVisible()` is still open — never an
    /// extra decrement that could steal another window's share of
    /// `ReadinessModel`'s shared visibility depth count.
    public var readinessIsVisible = false
    /// The "Setup status…" window renders screen 3 as a health view, not as a
    /// wizard step: there is no flow behind it to walk back into, and its
    /// primary button closes. A Continue here would advance into `.install`
    /// and start a real `rt setup apply` — whose next `start()` SIGTERMs the
    /// previous process, killing a live install the onboarding window owns.
    public let readOnly: Bool
    public init(readOnly: Bool = false) { self.readOnly = readOnly }

    public var showsBack: Bool { !readOnly }
    public var primaryClosesWindow: Bool { readOnly }
    public var mayStartInstall: Bool { !readOnly }

    public var canGoBack: Bool {
        guard !readOnly else { return false }
        switch step {
        case .welcome, .done: return false
        case .install: return !isInstalling
        default: return true
        }
    }
    public var continueTitle: String {
        if readOnly { return "Close" }
        switch step {
        case .checklist: return "Install"
        case .done: return "Finish"
        default: return "Continue"
        }
    }
    public var windowMayClose: Bool { step == .done }

    public func next() { if let n = SetupStep(rawValue: step.rawValue + 1) { step = n } }
    public func back() { guard canGoBack, let p = SetupStep(rawValue: step.rawValue - 1) else { return }; step = p }
    public func jump(to s: SetupStep) { step = s }
}
