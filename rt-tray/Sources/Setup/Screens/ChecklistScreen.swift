import SwiftUI
import MattstackCore

// replaced in Task 14
struct ChecklistScreen: View {
    @ObservedObject var model: ReadinessModel
    let permissions: PermissionsService
    let rt: RtRunning
    let bundleId: String
    var body: some View { Text("checklist") }
}
