import SwiftUI
import MattstackCore

struct TeamScreen: View {
    @ObservedObject var model: TeamChoiceModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                card(.create, title: "Create a team", systemImage: "person.3") { createFields }
                card(.join, title: "Join a team", systemImage: "person.crop.circle.badge.plus") { joinFields }
                card(.restore, title: "Already have mattstack settings?", systemImage: "arrow.counterclockwise.icloud", compact: true) { restoreFields }
            }
            .padding(20)
        }
        .task { await model.loadGitHubStatus() }
        .accessibilityIdentifier(AXID.teamScreen)
    }

    @ViewBuilder
    private func card<Content: View>(_ choice: TeamChoice, title: String, systemImage: String, compact: Bool = false,
                                     @ViewBuilder content: () -> Content) -> some View {
        let selected = model.choice == choice
        VStack(alignment: .leading, spacing: 10) {
            Button { model.choice = choice } label: {
                HStack {
                    Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    Label(title, systemImage: systemImage).font(compact ? .body : .headline)
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(cardID(choice))
            .accessibilityAddTraits(selected ? [.isSelected] : [])
            if selected { content().padding(.leading, 24) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Color.accentColor : Color.clear, lineWidth: 1))
    }

    private func cardID(_ c: TeamChoice) -> String {
        switch c { case .create: return AXID.teamCardCreate; case .join: return AXID.teamCardJoin; case .restore: return AXID.teamCardRestore }
    }

    private var createFields: some View {
        Form {
            TextField("Team name", text: $model.teamName, prompt: Text("Acme")).accessibilityIdentifier(AXID.teamCreateName)
            LabeledContent("Slug") { Text(model.slugPreview.isEmpty ? "—" : model.slugPreview).foregroundStyle(.secondary) }
            Toggle("Others will join later", isOn: $model.othersWillJoin).toggleStyle(.switch).controlSize(.small).accessibilityIdentifier(AXID.teamCreateOthers)
            if model.ghHandle != nil {
                Toggle("Create a private GitHub repo \(model.ghRepoPreview)", isOn: $model.useGhRepo).toggleStyle(.switch).controlSize(.small).accessibilityIdentifier(AXID.teamCreateUseGh)
                if model.useGhRepo {
                    Picker("Owner", selection: Binding(get: { model.ghOwner ?? "" }, set: { model.ghOwner = $0 })) {
                        ForEach(model.ghOwners, id: \.self) { Text($0).tag($0) }
                    }
                    .accessibilityIdentifier(AXID.teamCreateOwner)
                }
            }
            if !model.useGhRepo {
                TextField("Repository URL", text: $model.remoteURL, prompt: Text("paste an empty repo's URL; GitHub, GitLab, anything git can push to"))
                    .accessibilityIdentifier(AXID.teamCreateRemote)
            }
            if model.isChecking { checkingRow }
            Text(TeamChoiceModel.explainer).font(.callout).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }

    private var joinFields: some View {
        Form {
            VStack(alignment: .leading, spacing: 4) {
                Text("Invite code")
                TextEditor(text: $model.inviteCode)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 54)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                    .accessibilityIdentifier(AXID.teamJoinCode)
                HStack {
                    Button("Paste invite") { model.pasteInvite() }
                        .accessibilityIdentifier(AXID.teamPasteInvite)
                    Text("macOS may ask permission to read your clipboard.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("Paste the whole code (about \(TeamChoiceModel.inviteCodeLength) characters), or paste the mattstack://join link you were sent.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let s = model.joinSummary { Label(s, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            if let w = model.joinWarning { Label(w, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityIdentifier(AXID.teamJoinWarning) }
            if model.isChecking { checkingRow }
            Text(TeamChoiceModel.explainer).font(.callout).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }

    private var restoreFields: some View {
        Form {
            TextField("Home repo", text: $model.restoreRepo, prompt: Text("<org>/<repo>")).accessibilityIdentifier(AXID.teamRestoreRepo)
            SecureField("Age key (from your password manager)", text: $model.restoreAgeKey).accessibilityIdentifier(AXID.teamRestoreKey)
            Text("Clones your settings to ~/.mattstack, installs the key in the Keychain, and replays your teams and packs during Install.")
                .font(.caption).foregroundStyle(.secondary)
            if model.isChecking { checkingRow }
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
    }

    private var checkingRow: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text("Checking with rt…").font(.caption).foregroundStyle(.secondary)
        }
    }
}
