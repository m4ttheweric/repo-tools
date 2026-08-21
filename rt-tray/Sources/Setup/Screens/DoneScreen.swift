import SwiftUI
import MattstackCore

// replaced in Task 16
struct DoneScreen: View {
    @ObservedObject var install: InstallRunModel
    let isOwner: Bool
    let onInvite: () -> Void
    var body: some View { Text("done") }
}
