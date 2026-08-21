import Foundation

/// Stable accessibility identifiers. An out-of-process UI walkthrough drives
/// the app by these names through System Events, so they are a contract:
/// renaming one breaks that walkthrough.
enum AXID {
    // Setup window chrome
    static let stepIndicator = "setup.window.stepIndicator"
    static func `continue`(_ screen: String) -> String { "setup.\(screen).continue" }
    static func back(_ screen: String) -> String { "setup.\(screen).back" }
    static func error(_ screen: String) -> String { "setup.\(screen).error" }
    static let continueLimited = "setup.checklist.continueLimited"

    // Screens (the root view of each)
    static let welcomeScreen = "setup.welcome.screen"
    static let teamScreen = "setup.team.screen"
    static let checklistScreen = "setup.checklist.screen"
    static let installScreen = "setup.install.screen"
    static let doneScreen = "setup.done.screen"

    // Your team
    static let teamCardCreate = "setup.team.card.create"
    static let teamCardJoin = "setup.team.card.join"
    static let teamCardRestore = "setup.team.card.restore"
    static let teamCreateName = "setup.team.create.name"
    static let teamCreateOthers = "setup.team.create.others"
    static let teamCreateUseGh = "setup.team.create.useGh"
    static let teamCreateOwner = "setup.team.create.owner"
    static let teamCreateRemote = "setup.team.create.remote"
    static let teamJoinCode = "setup.team.join.code"
    static let teamRestoreRepo = "setup.team.restore.repo"
    static let teamRestoreKey = "setup.team.restore.key"

    // Checklist
    static func checklistRow(_ id: String) -> String { "setup.checklist.row.\(id)" }
    static func checklistRowAction(_ id: String) -> String { "setup.checklist.row.\(id).action" }
    static func checklistRowStatus(_ id: String) -> String { "setup.checklist.row.\(id).status" }
    static func checklistRowError(_ id: String) -> String { "setup.checklist.row.\(id).error" }
    static let checklistRecheck = "setup.checklist.recheck"
    static let checklistRelaunch = "setup.checklist.relaunch"
    static func connectField(_ name: String) -> String { "setup.checklist.connect.field.\(name)" }
    static func connectAlternative(_ id: String) -> String { "setup.checklist.connect.alt.\(id)" }
    static let connectSubmit = "setup.checklist.connect.submit"
    static let connectCancel = "setup.checklist.connect.cancel"
    static let stepsDone = "setup.checklist.steps.done"

    // Install
    static func installStep(_ id: String) -> String { "setup.install.step.\(id)" }
    static func installStepLog(_ id: String) -> String { "setup.install.step.\(id).log" }
    static func installStepStatus(_ id: String) -> String { "setup.install.step.\(id).status" }
    static let installRetry = "setup.install.retry"
    static let installRetryStream = "setup.install.retryStream"
    static let installNotes = "setup.install.notes"
    static let logCopy = "setup.install.log.copy"
    static let logDone = "setup.install.log.done"

    // Done
    static let doneOpenBoard = "setup.done.openBoard"
    static let doneInvite = "setup.done.invite"

    // Settings
    static func settingsTab(_ pane: String) -> String { "settings.tab.\(pane)" }
    static let settingsGeneralStartAtLogin = "settings.general.startAtLogin"
    static let settingsGeneralAutoUpdates = "settings.general.autoUpdates"
    static let settingsGeneralCheckNow = "settings.general.checkNow"
    static let settingsGeneralDevMode = "settings.general.devMode"
    static func settingsPermissionRow(_ id: String) -> String { "settings.permissions.row.\(id)" }
    static func settingsPermissionRowStatus(_ id: String) -> String { "settings.permissions.row.\(id).status" }
    static func settingsPermissionAction(_ id: String) -> String { "settings.permissions.row.\(id).action" }
    static let settingsPermissionsReset = "settings.permissions.reset"
    static let settingsPermissionsRelaunch = "settings.permissions.relaunch"
    static let settingsTeamInviteHandle = "settings.team.inviteHandle"
    static let settingsTeamInvite = "settings.team.invite"
    static let settingsTeamCopyRemote = "settings.team.copyRemote"
    static let settingsTeamCopyPaste = "settings.team.copyPasteBlock"
    static let settingsTeamJoinAnother = "settings.team.joinAnother"
    static let settingsUninstall = "settings.uninstall.button"
    static let settingsUninstallCancel = "settings.uninstall.cancel"
    static let settingsUninstallConfirm = "settings.uninstall.confirm"
    static let settingsUninstallKeepData = "settings.uninstall.keepData"

    // Menu (app menu + tray gear menu)
    static let menuAppSettings = "menu.app.settings"
    static let menuGearSetupStatus = "menu.gear.setupStatus"
    static let menuGearSettings = "menu.gear.settings"
    static let menuGearUninstall = "menu.gear.uninstall"
    static let menuGearCheckForUpdates = "menu.gear.checkForUpdates"
}
