import SwiftUI
import AppKit

class ProcessPanelController: ObservableObject {
    @Published var repoGroups: [RepoGroup] = []
    @Published var lastUpdated: Date = Date()
    @Published var selectedRepo: String? = nil
    @Published var selection: Set<Int> = []
    @Published var isLoading = true
    @Published var isRefreshing = false
    @Published var killingGroup: String? = nil

    private let daemonClient = DaemonClient()
    private var pollTimer: Timer?

    func startPolling() {
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refresh() {
        isRefreshing = true
        Task {
            guard let data = await daemonClient.querySystemProcesses() else {
                await MainActor.run {
                    self.isLoading = false
                    self.isRefreshing = false
                }
                return
            }
            let grouped = Dictionary(grouping: data.processes, by: \.repo)
            let groups = grouped.map { (repo, procs) in
                RepoGroup(
                    name: repo,
                    processes: procs.sorted { $0.cpuPercent > $1.cpuPercent },
                    totalCpu: procs.reduce(0) { $0 + ($1.totalCpuPercent ?? $1.cpuPercent) }
                )
            }.sorted { $0.name < $1.name }

            await MainActor.run {
                self.repoGroups = groups
                self.lastUpdated = Date(timeIntervalSince1970: data.updatedAt / 1000)
                self.isLoading = false
                self.isRefreshing = false
            }
        }
    }

    func killAllInGroup(_ group: RepoGroup) {
        killingGroup = group.name
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            for proc in group.processes {
                for pid in proc.allPids {
                    guard pid > 1 else { continue }
                    kill(-Int32(pid), SIGTERM)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self?.killingGroup = nil
                self?.refresh()
            }
        }
    }

    func killSelected() {
        for pid in selection {
            guard pid > 1 else { continue }
            kill(-Int32(pid), SIGTERM)
        }
        selection.removeAll()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refresh()
        }
    }

    func killProcess(_ pid: Int, force: Bool = false) {
        guard pid > 1 else { return }
        let signal: Int32 = force ? SIGKILL : SIGTERM
        kill(-Int32(pid), signal)
        if !force {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                if kill(Int32(pid), 0) == 0 {
                    kill(-Int32(pid), SIGKILL)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.refresh()
        }
    }

    func killProcessTree(_ proc: SystemProcess) {
        for pid in proc.allPids {
            killProcess(pid)
        }
    }

    func copyProcessInfo(_ proc: SystemProcess) {
        let info = [
            "PID: \(proc.pid)",
            "Command: \(proc.fullCommand)",
            "CWD: \(proc.cwd)",
            proc.branch.map { "Branch: \($0)" },
            proc.port.map { "Port: \($0)" },
            "CPU: \(proc.cpuFormatted)",
            "Memory: \(proc.memoryMB)",
            "Uptime: \(proc.uptime)",
        ].compactMap { $0 }.joined(separator: "\n")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(info, forType: .string)
    }

    func herdrFocusProcess(_ proc: SystemProcess) {
        Task.detached {
            if let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) {
                HerdrBridge.shared.focusPane(pane)
            }
        }
    }

    func herdrReadOutput(_ proc: SystemProcess) {
        Task.detached {
            if let pane = HerdrBridge.shared.findPane(forPid: proc.pid, cwd: proc.cwd) {
                if let output = HerdrBridge.shared.readPaneOutput(pane.paneId) {
                    await MainActor.run {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(output, forType: .string)
                    }
                }
            }
        }
    }

    var filteredGroups: [RepoGroup] {
        guard let selected = selectedRepo else { return repoGroups }
        return repoGroups.filter { $0.name == selected }
    }

    var totalProcessCount: Int {
        func countTree(_ proc: SystemProcess) -> Int {
            return 1 + (proc.children ?? []).reduce(0) { $0 + countTree($1) }
        }
        return repoGroups.flatMap(\.processes).reduce(0) { $0 + countTree($1) }
    }

    var repoNames: [String] {
        repoGroups.map(\.name)
    }
}

// MARK: - Main View

struct ProcessPanelView: View {
    @StateObject private var controller = ProcessPanelController()
    @StateObject private var columnSettings = ColumnSettings()
    @State private var showColumnPicker = false

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()
            if controller.isLoading {
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
        .frame(width: 700, height: 500)
        .onAppear { controller.startPolling() }
        .onDisappear { controller.stopPolling() }
    }

    // MARK: - Header

    private var headerBar: some View {
        HStack(spacing: 6) {
            PanelChip("All", selected: controller.selectedRepo == nil) {
                controller.selectedRepo = nil
            }
            ForEach(controller.repoNames, id: \.self) { repo in
                PanelChip(repo, selected: controller.selectedRepo == repo) {
                    controller.selectedRepo = repo
                }
            }

            Spacer()

            if !controller.selection.isEmpty {
                PanelButton(
                    label: "Kill \(controller.selection.count)",
                    icon: "xmark.circle",
                    role: .destructive,
                    action: { controller.killSelected() }
                )
            }

            Text("\(controller.totalProcessCount) processes")
                .font(.caption)
                .foregroundColor(.secondary)

            PanelButton(label: nil, icon: "line.3.horizontal.decrease", action: {
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
                action: { controller.refresh() }
            )
            .help("Refresh")

            PanelButton(label: nil, icon: "arrow.up.left.and.arrow.down.right", action: {
                NotificationCenter.default.post(name: .detachProcessPanel, object: nil)
            })
            .help("Open in window")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
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
            }
        }
        .padding(12)
    }

    // MARK: - Process Table (NSOutlineView)

    private var processTable: some View {
        ProcessOutlineView(
            groups: controller.filteredGroups,
            visibleColumns: columnSettings.visibleColumns,
            killingGroup: controller.killingGroup,
            selection: controller.selection,
            controller: controller
        )
    }

    // MARK: - Empty & Footer

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.title)
                .foregroundColor(.secondary)
            Text("No processes running")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var footerBar: some View {
        HStack {
            Text("Updated \(controller.lastUpdated, style: .relative) ago")
                .font(.caption2)
                .foregroundColor(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

// MARK: - Outline Item Wrappers (reference types for NSOutlineView)

final class OutlineGroupItem: NSObject {
    var group: RepoGroup
    var processItems: [OutlineProcessItem]

    init(_ group: RepoGroup) {
        self.group = group
        self.processItems = group.processes.map { OutlineProcessItem($0) }
    }

    func updateData(from group: RepoGroup) {
        self.group = group
        let newProcs = group.processes
        let existingByPid = Dictionary(uniqueKeysWithValues: processItems.map { ($0.process.pid, $0) })
        var updated: [OutlineProcessItem] = []
        for proc in newProcs {
            if let existing = existingByPid[proc.pid] {
                existing.updateData(from: proc)
                updated.append(existing)
            } else {
                updated.append(OutlineProcessItem(proc))
            }
        }
        processItems = updated
    }

    var processFingerprint: Set<Int> {
        Set(processItems.map { $0.process.pid })
    }
}

final class OutlineProcessItem: NSObject {
    var process: SystemProcess
    var childItems: [OutlineProcessItem]

    init(_ process: SystemProcess) {
        self.process = process
        self.childItems = (process.children ?? []).map { OutlineProcessItem($0) }
    }

    func updateData(from proc: SystemProcess) {
        self.process = proc
        let newChildren = proc.children ?? []
        let existingByPid = Dictionary(uniqueKeysWithValues: childItems.map { ($0.process.pid, $0) })
        var updated: [OutlineProcessItem] = []
        for child in newChildren {
            if let existing = existingByPid[child.pid] {
                existing.updateData(from: child)
                updated.append(existing)
            } else {
                updated.append(OutlineProcessItem(child))
            }
        }
        childItems = updated
    }
}

// MARK: - NSOutlineView Wrapper

struct ProcessOutlineView: NSViewRepresentable {
    let groups: [RepoGroup]
    let visibleColumns: Set<ProcessColumn>
    let killingGroup: String?
    let selection: Set<Int>
    let controller: ProcessPanelController

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder

        let outlineView = ProcessOutlineNSView()
        outlineView.coordinator = context.coordinator
        outlineView.dataSource = context.coordinator
        outlineView.delegate = context.coordinator
        outlineView.usesAlternatingRowBackgroundColors = true
        outlineView.allowsMultipleSelection = true
        outlineView.allowsEmptySelection = true
        outlineView.allowsColumnReordering = false
        outlineView.rowHeight = 22
        outlineView.intercellSpacing = NSSize(width: 6, height: 2)
        outlineView.headerView = NSTableHeaderView()
        outlineView.floatsGroupRows = false
        outlineView.indentationPerLevel = 16

        for col in ProcessColumn.allCases {
            let id = NSUserInterfaceItemIdentifier(col.rawValue)
            let tableColumn = NSTableColumn(identifier: id)
            tableColumn.title = col.rawValue
            tableColumn.isHidden = !visibleColumns.contains(col)
            tableColumn.resizingMask = [.userResizingMask, .autoresizingMask]

            let (minW, defaultW, alignment) = columnSpec(col)
            tableColumn.minWidth = minW
            tableColumn.width = defaultW
            tableColumn.headerCell.alignment = alignment

            let defaultAscending = (col != .cpu && col != .memory)
            tableColumn.sortDescriptorPrototype = NSSortDescriptor(key: col.rawValue, ascending: defaultAscending)

            outlineView.addTableColumn(tableColumn)
        }

        if let commandCol = outlineView.tableColumn(withIdentifier: NSUserInterfaceItemIdentifier(ProcessColumn.command.rawValue)) {
            outlineView.outlineTableColumn = commandCol
        }

        let menu = NSMenu()
        menu.delegate = context.coordinator
        outlineView.menu = menu

        context.coordinator.outlineView = outlineView
        scrollView.documentView = outlineView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.isSyncing = true
        defer { coordinator.isSyncing = false }

        coordinator.controller = controller
        coordinator.currentKillingGroup = killingGroup

        guard let outlineView = coordinator.outlineView else { return }

        for col in ProcessColumn.allCases {
            let id = NSUserInterfaceItemIdentifier(col.rawValue)
            if let tableCol = outlineView.tableColumn(withIdentifier: id) {
                tableCol.isHidden = !visibleColumns.contains(col)
            }
        }

        let structureChanged = coordinator.updateItems(from: groups)
        coordinator.applySortToItems()

        if structureChanged {
            outlineView.reloadData()
            coordinator.restoreExpansion()
        } else {
            outlineView.reloadItem(nil, reloadChildren: true)
        }

        var indexSet = IndexSet()
        for row in 0..<outlineView.numberOfRows {
            if let processItem = outlineView.item(atRow: row) as? OutlineProcessItem,
               selection.contains(processItem.process.pid) {
                indexSet.insert(row)
            }
        }
        outlineView.selectRowIndexes(indexSet, byExtendingSelection: false)
    }

    private func columnSpec(_ col: ProcessColumn) -> (CGFloat, CGFloat, NSTextAlignment) {
        switch col {
        case .command:      return (120, 200, .left)
        case .cpu:          return (45,  55,  .right)
        case .memory:       return (50,  60,  .right)
        case .port:         return (40,  50,  .right)
        case .branch:       return (80,  120, .left)
        case .linearTicket: return (80,  120, .left)
        case .pid:          return (40,  55,  .right)
        case .uptime:       return (50,  70,  .right)
        case .worktree:     return (70,  100, .left)
        case .cwd:          return (80,  120, .left)
        case .fullCommand:  return (80,  150, .left)
        }
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSMenuDelegate {
        var groupItems: [OutlineGroupItem] = []
        weak var controller: ProcessPanelController?
        weak var outlineView: ProcessOutlineNSView?
        var isSyncing = false
        var collapsedGroups: Set<String> = []
        var expandedProcessPids: Set<Int> = []
        var currentKillingGroup: String?
        var activeSortColumn: ProcessColumn? = nil
        var activeSortAscending: Bool = true

        /// Updates items in-place when possible, returns true if the tree structure changed.
        func updateItems(from groups: [RepoGroup]) -> Bool {
            let oldNames = groupItems.map { $0.group.name }
            let newNames = groups.map { $0.name }

            if oldNames != newNames {
                groupItems = groups.map { OutlineGroupItem($0) }
                return true
            }

            let existingByName = Dictionary(uniqueKeysWithValues: groupItems.map { ($0.group.name, $0) })
            for group in groups {
                guard let existing = existingByName[group.name] else {
                    groupItems = groups.map { OutlineGroupItem($0) }
                    return true
                }
                let oldPids = existing.processFingerprint
                let newPids = Set(group.processes.map { $0.pid })
                if oldPids != newPids {
                    groupItems = groups.map { OutlineGroupItem($0) }
                    return true
                }
                existing.updateData(from: group)
            }
            return false
        }

        // MARK: Data Source

        func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
            if item == nil { return groupItems.count }
            if let group = item as? OutlineGroupItem { return group.processItems.count }
            if let proc = item as? OutlineProcessItem { return proc.childItems.count }
            return 0
        }

        func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
            if item == nil { return groupItems[index] }
            if let group = item as? OutlineGroupItem { return group.processItems[index] }
            if let proc = item as? OutlineProcessItem { return proc.childItems[index] }
            fatalError("Unexpected outline item")
        }

        func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
            if let group = item as? OutlineGroupItem { return !group.processItems.isEmpty }
            if let proc = item as? OutlineProcessItem { return !proc.childItems.isEmpty }
            return false
        }

        // MARK: Delegate

        func outlineView(_ outlineView: NSOutlineView, isGroupItem item: Any) -> Bool {
            return item is OutlineGroupItem
        }

        func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
            return item is OutlineProcessItem
        }

        func outlineView(_ outlineView: NSOutlineView, heightOfRowByItem item: Any) -> CGFloat {
            return item is OutlineGroupItem ? 26 : 22
        }

        func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
            if let group = item as? OutlineGroupItem {
                return makeGroupView(group)
            }
            guard let processItem = item as? OutlineProcessItem,
                  let colId = tableColumn?.identifier.rawValue,
                  let column = ProcessColumn(rawValue: colId) else { return nil }
            return makeCellView(processItem.process, column: column,
                               isParent: !processItem.childItems.isEmpty, in: outlineView)
        }

        func outlineViewSelectionDidChange(_ notification: Notification) {
            guard !isSyncing, let outlineView = outlineView else { return }
            var pids = Set<Int>()
            for row in outlineView.selectedRowIndexes {
                if let item = outlineView.item(atRow: row) as? OutlineProcessItem {
                    pids.insert(item.process.pid)
                }
            }
            controller?.selection = pids
        }

        func outlineViewItemDidExpand(_ notification: Notification) {
            guard !isSyncing else { return }
            guard let item = notification.userInfo?["NSObject"] else { return }
            if let group = item as? OutlineGroupItem {
                collapsedGroups.remove(group.group.name)
            } else if let proc = item as? OutlineProcessItem {
                expandedProcessPids.insert(proc.process.pid)
            }
        }

        func outlineViewItemDidCollapse(_ notification: Notification) {
            guard !isSyncing else { return }
            guard let item = notification.userInfo?["NSObject"] else { return }
            if let group = item as? OutlineGroupItem {
                collapsedGroups.insert(group.group.name)
            } else if let proc = item as? OutlineProcessItem {
                expandedProcessPids.remove(proc.process.pid)
            }
        }

        // MARK: Sorting

        func outlineView(_ outlineView: NSOutlineView, sortDescriptorsDidChange oldDescriptors: [NSSortDescriptor]) {
            guard let descriptor = outlineView.sortDescriptors.first,
                  let key = descriptor.key,
                  let column = ProcessColumn(rawValue: key) else {
                activeSortColumn = nil
                return
            }
            activeSortColumn = column
            activeSortAscending = descriptor.ascending
            applySortToItems()

            isSyncing = true
            defer { isSyncing = false }
            outlineView.reloadData()
            restoreExpansion()
        }

        func applySortToItems() {
            guard let column = activeSortColumn else { return }
            let ascending = activeSortAscending
            for group in groupItems {
                group.processItems.sort { a, b in
                    let cmp = Self.compareProcesses(a.process, b.process, by: column)
                    return ascending ? cmp == .orderedAscending : cmp == .orderedDescending
                }
            }
        }

        func restoreExpansion() {
            guard let outlineView = outlineView else { return }
            for item in groupItems {
                if !collapsedGroups.contains(item.group.name) {
                    outlineView.expandItem(item)
                    for procItem in item.processItems {
                        if expandedProcessPids.contains(procItem.process.pid) {
                            outlineView.expandItem(procItem)
                        }
                    }
                }
            }
        }

        private static func compareProcesses(_ a: SystemProcess, _ b: SystemProcess,
                                              by column: ProcessColumn) -> ComparisonResult {
            switch column {
            case .command:
                return a.command.localizedCaseInsensitiveCompare(b.command)
            case .cpu:
                let av = a.totalCpuPercent ?? a.cpuPercent
                let bv = b.totalCpuPercent ?? b.cpuPercent
                return av < bv ? .orderedAscending : av > bv ? .orderedDescending : .orderedSame
            case .memory:
                let av = a.totalRssKb ?? a.rssKb
                let bv = b.totalRssKb ?? b.rssKb
                return av < bv ? .orderedAscending : av > bv ? .orderedDescending : .orderedSame
            case .port:
                let av = a.port ?? 0
                let bv = b.port ?? 0
                return av < bv ? .orderedAscending : av > bv ? .orderedDescending : .orderedSame
            case .branch:
                return (a.branch ?? "").localizedCaseInsensitiveCompare(b.branch ?? "")
            case .linearTicket:
                return (a.linearTicket ?? "").localizedCaseInsensitiveCompare(b.linearTicket ?? "")
            case .pid:
                return a.pid < b.pid ? .orderedAscending : a.pid > b.pid ? .orderedDescending : .orderedSame
            case .uptime:
                return a.uptime.compare(b.uptime)
            case .worktree:
                return a.relativeDir.localizedCaseInsensitiveCompare(b.relativeDir)
            case .cwd:
                return a.cwd.localizedCaseInsensitiveCompare(b.cwd)
            case .fullCommand:
                return a.fullCommand.localizedCaseInsensitiveCompare(b.fullCommand)
            }
        }

        // MARK: Group Row View

        private func makeGroupView(_ group: OutlineGroupItem) -> NSView {
            let cell = NSView()

            let stack = NSStackView()
            stack.orientation = .horizontal
            stack.spacing = 6
            stack.alignment = .centerY
            stack.translatesAutoresizingMaskIntoConstraints = false

            let nameLabel = NSTextField(labelWithString: group.group.name)
            nameLabel.font = .systemFont(ofSize: 11, weight: .semibold)
            stack.addArrangedSubview(nameLabel)

            let countLabel = NSTextField(labelWithString: "(\(group.group.processes.count))")
            countLabel.font = .systemFont(ofSize: 11)
            countLabel.textColor = .secondaryLabelColor
            stack.addArrangedSubview(countLabel)

            let cpuLabel = NSTextField(labelWithString: String(format: "%.1f%% CPU", group.group.totalCpu))
            cpuLabel.font = .systemFont(ofSize: 11)
            cpuLabel.textColor = .secondaryLabelColor
            stack.addArrangedSubview(cpuLabel)

            let spacer = NSView()
            spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            stack.addArrangedSubview(spacer)

            if currentKillingGroup == group.group.name {
                let progress = NSProgressIndicator()
                progress.style = .spinning
                progress.controlSize = .small
                progress.isIndeterminate = true
                progress.startAnimation(nil)
                stack.addArrangedSubview(progress)

                let killingLabel = NSTextField(labelWithString: "Killing...")
                killingLabel.font = .systemFont(ofSize: 10)
                killingLabel.textColor = .secondaryLabelColor
                stack.addArrangedSubview(killingLabel)
            } else {
                let killButton = HoverButton(title: "Kill All", target: self, action: #selector(killGroupClicked(_:)))
                killButton.isBordered = false
                killButton.font = .systemFont(ofSize: 10, weight: .medium)
                killButton.contentTintColor = .systemRed
                killButton.tag = groupItems.firstIndex(where: { $0 === group }) ?? -1
                stack.addArrangedSubview(killButton)
            }

            cell.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
                stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8),
                stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell
        }

        @objc private func killGroupClicked(_ sender: NSButton) {
            guard sender.tag >= 0, sender.tag < groupItems.count else { return }
            controller?.killAllInGroup(groupItems[sender.tag].group)
        }

        // MARK: Process Cell Views

        private func makeCellView(_ proc: SystemProcess, column: ProcessColumn,
                                  isParent: Bool, in outlineView: NSOutlineView) -> NSView {
            if column == .command {
                return makeCommandCell(proc, isParent: isParent)
            }

            let identifier = NSUserInterfaceItemIdentifier("Cell-\(column.rawValue)")
            let cell: NSTableCellView
            if let existing = outlineView.makeView(withIdentifier: identifier, owner: nil) as? NSTableCellView {
                cell = existing
            } else {
                let newCell = NSTableCellView()
                newCell.identifier = identifier
                let tf = NSTextField(labelWithString: "")
                tf.isEditable = false
                tf.isBordered = false
                tf.drawsBackground = false
                tf.lineBreakMode = .byTruncatingTail
                tf.translatesAutoresizingMaskIntoConstraints = false
                newCell.addSubview(tf)
                newCell.textField = tf
                NSLayoutConstraint.activate([
                    tf.leadingAnchor.constraint(equalTo: newCell.leadingAnchor, constant: 2),
                    tf.trailingAnchor.constraint(equalTo: newCell.trailingAnchor, constant: -2),
                    tf.centerYAnchor.constraint(equalTo: newCell.centerYAnchor),
                ])
                cell = newCell
            }

            let (text, font, color, alignment) = cellConfig(proc, column)
            cell.textField?.stringValue = text
            cell.textField?.font = font
            cell.textField?.textColor = color
            cell.textField?.alignment = alignment
            return cell
        }

        private func makeCommandCell(_ proc: SystemProcess, isParent: Bool) -> NSView {
            let cell = NSTableCellView()

            let stack = NSStackView()
            stack.orientation = .horizontal
            stack.spacing = 4
            stack.alignment = .centerY
            stack.translatesAutoresizingMaskIntoConstraints = false

            if proc.isRunaway {
                let dot = NSView(frame: NSRect(x: 0, y: 0, width: 6, height: 6))
                dot.wantsLayer = true
                dot.layer?.backgroundColor = NSColor.systemOrange.cgColor
                dot.layer?.cornerRadius = 3
                dot.translatesAutoresizingMaskIntoConstraints = false
                dot.widthAnchor.constraint(equalToConstant: 6).isActive = true
                dot.heightAnchor.constraint(equalToConstant: 6).isActive = true
                stack.addArrangedSubview(dot)
            }

            let label = NSTextField(labelWithString: proc.command)
            label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            stack.addArrangedSubview(label)

            if isParent {
                let countLabel = NSTextField(labelWithString: "+\(proc.childCount)")
                countLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
                countLabel.textColor = .secondaryLabelColor
                countLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
                stack.addArrangedSubview(countLabel)
            }

            cell.addSubview(stack)
            cell.textField = label
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
                stack.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -2),
                stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            return cell
        }

        private func cellConfig(_ proc: SystemProcess, _ column: ProcessColumn)
            -> (String, NSFont, NSColor, NSTextAlignment) {
            let mono = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
            let regular = NSFont.systemFont(ofSize: 11)
            let primary = NSColor.labelColor
            let secondary = NSColor.secondaryLabelColor

            switch column {
            case .command:
                return (proc.command, mono, primary, .left)
            case .cpu:
                return (proc.cpuFormatted, mono, proc.cpuPercent > 80 ? .systemOrange : primary, .right)
            case .memory:
                return (proc.memoryMB, mono, primary, .right)
            case .port:
                return (proc.portFormatted, mono, primary, .right)
            case .branch:
                return (proc.branch ?? "", regular, secondary, .left)
            case .linearTicket:
                return (proc.linearTicket ?? "", regular, secondary, .left)
            case .pid:
                return ("\(proc.pid)", mono, secondary, .right)
            case .uptime:
                return (proc.uptime, mono, secondary, .right)
            case .worktree:
                return (proc.relativeDir, regular, secondary, .left)
            case .cwd:
                return (proc.cwd, regular, secondary, .left)
            case .fullCommand:
                return (proc.fullCommand, mono, secondary, .left)
            }
        }

        // MARK: Context Menu

        func menuNeedsUpdate(_ menu: NSMenu) {
            menu.removeAllItems()
            guard let outlineView = outlineView else { return }

            let clickedRow = outlineView.clickedRow
            guard clickedRow >= 0,
                  let processItem = outlineView.item(atRow: clickedRow) as? OutlineProcessItem
            else { return }

            let proc = processItem.process

            let killItem = NSMenuItem(title: "Kill Process", action: #selector(contextKillProcess(_:)), keyEquivalent: "")
            killItem.target = self
            killItem.representedObject = processItem
            menu.addItem(killItem)

            if proc.hasChildren {
                let treeItem = NSMenuItem(
                    title: "Kill Process Tree (\(proc.childCount + 1))",
                    action: #selector(contextKillTree(_:)), keyEquivalent: "")
                treeItem.target = self
                treeItem.representedObject = processItem
                menu.addItem(treeItem)
            }

            let forceItem = NSMenuItem(title: "Force Kill (SIGKILL)",
                                       action: #selector(contextForceKill(_:)), keyEquivalent: "")
            forceItem.target = self
            forceItem.representedObject = processItem
            menu.addItem(forceItem)

            menu.addItem(NSMenuItem.separator())

            let copyItem = NSMenuItem(title: "Copy Info",
                                      action: #selector(contextCopyInfo(_:)), keyEquivalent: "")
            copyItem.target = self
            copyItem.representedObject = processItem
            menu.addItem(copyItem)

            if HerdrBridge.shared.isAvailable {
                menu.addItem(NSMenuItem.separator())

                let focusItem = NSMenuItem(title: "Focus in Herdr",
                                           action: #selector(contextHerdrFocus(_:)), keyEquivalent: "")
                focusItem.target = self
                focusItem.representedObject = processItem
                menu.addItem(focusItem)

                let readItem = NSMenuItem(title: "Read Output",
                                          action: #selector(contextHerdrReadOutput(_:)), keyEquivalent: "")
                readItem.target = self
                readItem.representedObject = processItem
                menu.addItem(readItem)
            }
        }

        @objc private func contextKillProcess(_ sender: NSMenuItem) {
            guard let item = sender.representedObject as? OutlineProcessItem else { return }
            controller?.killProcess(item.process.pid)
        }

        @objc private func contextForceKill(_ sender: NSMenuItem) {
            guard let item = sender.representedObject as? OutlineProcessItem else { return }
            controller?.killProcess(item.process.pid, force: true)
        }

        @objc private func contextKillTree(_ sender: NSMenuItem) {
            guard let item = sender.representedObject as? OutlineProcessItem else { return }
            controller?.killProcessTree(item.process)
        }

        @objc private func contextCopyInfo(_ sender: NSMenuItem) {
            guard let item = sender.representedObject as? OutlineProcessItem else { return }
            controller?.copyProcessInfo(item.process)
        }

        @objc private func contextHerdrFocus(_ sender: NSMenuItem) {
            guard let item = sender.representedObject as? OutlineProcessItem else { return }
            controller?.herdrFocusProcess(item.process)
        }

        @objc private func contextHerdrReadOutput(_ sender: NSMenuItem) {
            guard let item = sender.representedObject as? OutlineProcessItem else { return }
            controller?.herdrReadOutput(item.process)
        }
    }
}

// MARK: - Custom NSOutlineView (right-click selects row before showing menu)

final class ProcessOutlineNSView: NSOutlineView {
    weak var coordinator: ProcessOutlineView.Coordinator?

    override func menu(for event: NSEvent) -> NSMenu? {
        let point = convert(event.locationInWindow, from: nil)
        let clickedRow = row(at: point)
        if clickedRow >= 0 && !selectedRowIndexes.contains(clickedRow) {
            selectRowIndexes(IndexSet(integer: clickedRow), byExtendingSelection: false)
        }
        return super.menu(for: event)
    }
}

// MARK: - Hover Button (borderless NSButton with hover background)

private final class HoverButton: NSButton {
    private var trackingArea: NSTrackingArea?
    var hoverColor: NSColor = NSColor.systemRed.withAlphaComponent(0.1)

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea { removeTrackingArea(existing) }
        let area = NSTrackingArea(rect: bounds,
                                  options: [.mouseEnteredAndExited, .activeAlways],
                                  owner: self)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        wantsLayer = true
        layer?.backgroundColor = hoverColor.cgColor
        layer?.cornerRadius = 4
    }

    override func mouseExited(with event: NSEvent) {
        layer?.backgroundColor = nil
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
                .font(.caption)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(chipBackground)
                .cornerRadius(4)
        }
        .buttonStyle(.borderless)
        .onHover { isHovering = $0 }
    }

    private var chipBackground: Color {
        if selected {
            return Color.accentColor.opacity(0.2)
        }
        if isHovering {
            return Color.primary.opacity(0.06)
        }
        return Color.clear
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
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.7)
                } else if let icon = icon {
                    Image(systemName: icon)
                        .font(.caption)
                }
                if let label = label {
                    Text(label)
                        .font(.caption2)
                }
            }
            .foregroundColor(foregroundColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(isHovering ? hoverBackground : Color.clear)
            .cornerRadius(4)
        }
        .buttonStyle(.borderless)
        .disabled(isLoading)
        .onHover { isHovering = $0 }
    }

    private var foregroundColor: Color {
        if isLoading { return .secondary }
        if role == .destructive { return .red }
        return .secondary
    }

    private var hoverBackground: Color {
        if role == .destructive { return Color.red.opacity(0.1) }
        return Color.primary.opacity(0.06)
    }
}

// MARK: - Double-Click (AppKit gesture, doesn't interfere with List selection)

struct DoubleClickOverlay: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        let gesture = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onDoubleClick))
        gesture.numberOfClicksRequired = 2
        gesture.delaysPrimaryMouseButtonEvents = false
        view.addGestureRecognizer(gesture)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    class Coordinator: NSObject {
        let action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func onDoubleClick() { action() }
    }
}

extension View {
    func onDoubleClick(perform action: @escaping () -> Void) -> some View {
        overlay { DoubleClickOverlay(action: action) }
    }
}
