import SwiftUI
import MattstackCore

struct TeamPane: View {
    let env: SettingsEnvironment
    @ObservedObject private var model: TeamSettingsModel
    @State private var handle = ""
    init(env: SettingsEnvironment) { self.env = env; self.model = env.team }

    var body: some View {
        Form {
            Section("Team") {
                LabeledContent("Name") { Text(model.info?.name ?? "—") }
                LabeledContent("Remote") {
                    HStack { Text(model.maskedRemote).textSelection(.enabled)
                        // Copies the masked form, never `model.info?.remote` —
                        // an HTTPS remote can carry a token in its userinfo.
                        Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.maskedRemote, forType: .string) } label: { Image(systemName: "doc.on.doc") }
                            .buttonStyle(.borderless)
                            .accessibilityIdentifier(AXID.settingsTeamCopyRemote) }
                }
                LabeledContent("Backup") { Text(model.info?.lastPush.map { "last push \($0)" } ?? "no push recorded") }
            }
            Section("Members with access") {
                if let m = model.info?.members, !m.isEmpty { ForEach(m, id: \.username) { Text($0.username) } }
                else { Text("Not visible with the current token.").foregroundStyle(.secondary) }
            }
            Section("Invite") {
                HStack {
                    TextField("Forge handle", text: $handle, prompt: Text("teammate's GitHub/GitLab handle")).accessibilityIdentifier(AXID.settingsTeamInviteHandle)
                    Button("Invite…") { Task { await model.mintInvite(handle: handle.trimmingCharacters(in: .whitespaces)) } }.disabled(handle.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier(AXID.settingsTeamInvite)
                }
                if let inv = model.invite {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(inv.pasteBlock).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        HStack {
                            Button("Copy paste block") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(inv.pasteBlock, forType: .string) }
                                .accessibilityIdentifier(AXID.settingsTeamCopyPaste)
                            Text("expires \(inv.expiresAt) · forge access: \(inv.forgeAccess)").font(.caption).foregroundStyle(.secondary)
                        }
                        if let steps = inv.manualSteps, !steps.isEmpty { ForEach(steps, id: \.self) { Text("• \($0)").font(.caption) } }
                    }
                }
            }
            Section { Button("Join another team…", action: env.onJoinAnotherTeam).accessibilityIdentifier(AXID.settingsTeamJoinAnother) }
            if let e = model.error { Text(e).font(.caption).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .task { await model.load() }
    }
}
