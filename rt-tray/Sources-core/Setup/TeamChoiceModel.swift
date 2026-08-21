import Foundation
import Combine

// replaced in Task 13
public enum TeamChoice: Equatable, Sendable { case create, join, restore }

// replaced in Task 13
@MainActor
public final class TeamChoiceModel: ObservableObject {
    @Published public var choice: TeamChoice = .create
    @Published public var inviteCode = ""
    public var canContinue: Bool { true }
    private let rt: RtRunning
    public init(rt: RtRunning) { self.rt = rt }
    public func validateAndPrepare() async -> String? { nil }
}
