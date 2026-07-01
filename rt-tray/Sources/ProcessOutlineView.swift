import SwiftUI
import AppKit

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
        let existingByPid = Dictionary(
            processItems.map { ($0.process.pid, $0) },
            uniquingKeysWith: { first, _ in first }
        )
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
        let existingByPid = Dictionary(
            childItems.map { ($0.process.pid, $0) },
            uniquingKeysWith: { first, _ in first }
        )
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

            let existingByName = Dictionary(
                groupItems.map { ($0.group.name, $0) },
                uniquingKeysWith: { first, _ in first }
            )
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
            if item is OutlineGroupItem { return 26 }
            if let proc = item as? OutlineProcessItem,
               proc.process.command.contains(" › ") {
                return 34
            }
            return 22
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
                killButton.groupName = group.group.name
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
            guard let name = (sender as? HoverButton)?.groupName,
                  let item = groupItems.first(where: { $0.group.name == name }) else { return }
            controller?.killAllInGroup(item.group)
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

            // Split breadcrumb chain (e.g. "bun › node › foo") into ancestry + leaf
            let parts = proc.command.components(separatedBy: " › ")
            let leafName = parts.last ?? proc.command
            let ancestryParts = parts.dropLast()

            let nameStack = NSStackView()
            nameStack.orientation = .vertical
            nameStack.alignment = .leading
            nameStack.spacing = 1
            nameStack.edgeInsets = NSEdgeInsets(top: 2, left: 0, bottom: 0, right: 0)
            nameStack.translatesAutoresizingMaskIntoConstraints = false

            if !ancestryParts.isEmpty {
                let chainText = ancestryParts.joined(separator: " \u{2192} ")
                let chainLabel = NSTextField(labelWithString: chainText)
                chainLabel.setContentHuggingPriority(.required, for: .vertical)
                chainLabel.font = .systemFont(ofSize: 9.5, weight: .regular)
                chainLabel.textColor = .secondaryLabelColor
                chainLabel.lineBreakMode = .byTruncatingTail
                chainLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                nameStack.addArrangedSubview(chainLabel)
            }

            let leafRow = NSStackView()
            leafRow.orientation = .horizontal
            leafRow.spacing = 4

            let label = NSTextField(labelWithString: leafName)
            label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            leafRow.addArrangedSubview(label)

            if isParent {
                let countLabel = NSTextField(labelWithString: "+\(proc.childCount)")
                countLabel.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
                countLabel.textColor = .secondaryLabelColor
                countLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
                leafRow.addArrangedSubview(countLabel)
            }

            nameStack.addArrangedSubview(leafRow)
            stack.addArrangedSubview(nameStack)

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
                    title: "Kill Process Tree (\(proc.allPids.count))",
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
    /// Repo-group key for kill actions — looked up by name at click time so a
    /// rebuilt `groupItems` array can't misroute the click (unlike an index tag).
    var groupName: String?

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
